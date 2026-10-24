// lipsync-runner.swift — wav2lip256 (LiveTalking's checkpoint, Core ML fp16) on BOTH GPUs of an Intel MacBook Pro.
//
// The live engine (engine.py) owns TTS, mel features and the WebSocket; this process owns the GPUs.
// One worker per Metal device (Radeon + Intel UHD), each with its own MLModel pinned via
// preferredMetalDevice — Core ML otherwise picks whichever GPU happens to be awake, and the two
// together are ~2x one. Frames are handed out round-robin and answered as soon as they're done.
//
// build (universal, bundled in Terse.app): src/helpers/gf-live/build-gf-live.sh
// usage: terse-gf-lipsync <enc.mlpackage> <dec.mlpackage>     (JPEG of length 0 = patch rejected as GPU garbage)
// stdin  (little endian):
//   'A' u32 n, then n × float32[6·256·256]          avatar: encoder inputs (masked+ref face, CHW, 0..1, BGR)
//   'U' u32 n, then n × uint8[6·256·256]            same, 0..255 (what engine.py sends: 4x less data)
//   'P' u32 req, u32 base, f32 alpha, u16 w, u16 h, float32[80·16]   one mouth patch
// stdout: 'R' u32 req, u32 len, len bytes of JPEG (w×h, RGB)  |  'E' u32 len, utf8 message
import Foundation
import CoreML
import Metal
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import Accelerate

setvbuf(stdout, nil, _IOFBF, 1 << 20)
let outLock = NSLock()
func send(_ tag: UInt8, _ parts: [Data]) {
    outLock.lock(); defer { outLock.unlock() }
    var d = Data([tag]); for p in parts { d.append(p) }
    FileHandle.standardOutput.write(d)
}
func u32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
func fail(_ s: String) { let b = Data(s.utf8); send(UInt8(ascii: "E"), [u32(UInt32(b.count)), b]) }

let stdinH = FileHandle.standardInput
func readExactly(_ n: Int) -> Data? {
    var d = Data(); d.reserveCapacity(n)
    while d.count < n { let c = stdinH.readData(ofLength: n - d.count); if c.isEmpty { return nil }; d.append(c) }
    return d
}
func readU32() -> UInt32? { readExactly(4).map { $0.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) } } }

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: runner <enc> <dec>"); exit(1) }
func compiled(_ p: String) throws -> URL {
    // compile once, keep next to the package (compiling a 100 MB model takes ~10 s)
    let src = URL(fileURLWithPath: p)
    let dst = src.deletingPathExtension().appendingPathExtension("mlmodelc")
    if let a = try? FileManager.default.attributesOfItem(atPath: dst.path)[.modificationDate] as? Date,
       let b = try? FileManager.default.attributesOfItem(atPath: src.appendingPathComponent("Manifest.json").path)[.modificationDate] as? Date,
       a > b { return dst }
    let tmp = try MLModel.compileModel(at: src)
    try? FileManager.default.removeItem(at: dst)
    try FileManager.default.moveItem(at: tmp, to: dst)
    return dst
}
let encURL = try compiled(args[1]), decURL = try compiled(args[2])
let featNames = (0..<8).map { "f\($0)" }

final class Worker {
    let dev: MTLDevice, enc: MLModel, dec: MLModel
    init(_ dev: MTLDevice) throws {
        self.dev = dev
        let cfg = MLModelConfiguration(); cfg.computeUnits = .cpuAndGPU; cfg.preferredMetalDevice = dev
        enc = try MLModel(contentsOf: encURL, configuration: cfg)
        dec = try MLModel(contentsOf: decURL, configuration: cfg)
    }
}
var workers: [Worker] = []
// GF_GPUS="0" / "1" / "0,1": which Metal devices to use (index after sorting discrete first). Default: all.
let allowed = ProcessInfo.processInfo.environment["GF_GPUS"].map { Set($0.split(separator: ",").compactMap { Int($0) }) }
for (i, d) in MTLCopyAllDevices().sorted(by: { !$0.isLowPower && $1.isLowPower }).enumerated() {
    if let a = allowed, !a.contains(i) { continue }
    if let w = try? Worker(d) { workers.append(w) }
}
/* A GPU that starts returning garbage (hot / wedged — the state that preceded this Mac's kernel GPU restarts)
   is taken out of rotation after 3 bad frames in a row; its work goes to the healthy one(s). If all are bad,
   patches are simply skipped (the mouth stays as the video shows it) instead of hammering a sick GPU. */
var badStreak = [Int](repeating: 0, count: 8)
var disabled = Set<Int>()
let healthLock = NSLock()
func report(_ i: Int, ok: Bool) {
    healthLock.lock(); defer { healthLock.unlock() }
    badStreak[i] = ok ? 0 : badStreak[i] + 1
    if badStreak[i] >= 3 && !disabled.contains(i) {
        disabled.insert(i)
        FileHandle.standardError.write("lipsync-runner: \(workers[i].dev.name) returns garbage — disabled\n".data(using: .utf8)!)
    }
}
if workers.isEmpty { fail("no Metal device could load the model"); exit(1) }
FileHandle.standardError.write("lipsync-runner: \(workers.map { $0.dev.name }.joined(separator: " + "))\n".data(using: .utf8)!)

var feats: [[String: MLFeatureValue]] = []          // per idle frame, shared by all workers
var refTop: [[Float]] = []                           // per idle frame: upper half of the reference face (B channel, 128x256)
let featsLock = NSLock()

func multiArray(_ shape: [Int], _ src: UnsafeRawBufferPointer, _ offset: Int) throws -> MLMultiArray {
    let a = try MLMultiArray(shape: shape.map { NSNumber(value: $0) }, dataType: .float32)
    let n = shape.reduce(1, *)
    memcpy(a.dataPointer, src.baseAddress! + offset, n * 4)
    return a
}

/// A wedged GPU returns noise instead of failing. The model re-draws the upper face it was given almost
/// exactly, so if its upper half doesn't match the reference, the patch is garbage: drop it.
/// The hot GPU can also garble ONLY the lower face (user 10-19 screenshot: mosaic mouth, clean eyes), which the upper
/// check can't see: blocky multicolour noise has far more colour-edge energy than skin. Compare the lower half with the
/// patch's own (clean) upper half — measured: clean ≤ 1.75×, noise ≥ 3.4× (and ≥ 0.059 absolute).
func chromaEdges(_ f: [Float], _ y0: Int, _ y1: Int) -> Float {
    let S = 256, P = S * S; var e: Float = 0; var n = 0
    for y in stride(from: y0, to: y1, by: 2) { for x in stride(from: 16, to: 238, by: 2) {
        let i = y * S + x
        let a0 = f[i] - f[P + i], b0 = f[2 * P + i] - f[P + i]                         // B−G, R−G
        let a1 = f[i + 2] - f[P + i + 2], b1 = f[2 * P + i + 2] - f[P + i + 2]
        let a2 = f[i + 2 * S] - f[P + i + 2 * S], b2 = f[2 * P + i + 2 * S] - f[P + i + 2 * S]
        e += abs(a0 - a1) + abs(a0 - a2) + abs(b0 - b1) + abs(b0 - b2); n += 1 } }
    return e / Float(max(1, n))
}

func looksSane(_ f: [Float], _ ref: [Float]) -> Bool {
    let S = 256; var d: Float = 0; var n = 0
    for y in stride(from: 8, to: 120, by: 4) { for x in stride(from: 16, to: 240, by: 4) {
        d += abs(f[y * S + x] - ref[(y * S + x)]); n += 1 } }
    if d / Float(max(1, n)) >= 0.075 { return false }
    let lower = chromaEdges(f, 136, 246), upper = chromaEdges(f, 16, 120)
    return !(lower > 2.5 * upper && lower > 0.045)
}

func jpeg(_ pred: MLMultiArray, w: Int, h: Int, ref: [Float]?) -> Data? {
    // pred: [1,3,256,256] BGR 0..1 (fp16 or fp32) -> RGBA8 -> scaled CGImage -> JPEG
    let S = 256, plane = S * S
    var rgba = [UInt8](repeating: 255, count: plane * 4)
    var f = [Float](repeating: 0, count: plane * 3)
    if pred.dataType == .float16 {
        // Swift's Float16 doesn't exist on x86_64 macOS — let vImage widen the halves
        f.withUnsafeMutableBytes { dstB in
            var src = vImage_Buffer(data: pred.dataPointer, height: 1, width: vImagePixelCount(plane * 3), rowBytes: plane * 3 * 2)
            var dst = vImage_Buffer(data: dstB.baseAddress!, height: 1, width: vImagePixelCount(plane * 3), rowBytes: plane * 3 * 4)
            _ = vImageConvert_Planar16FtoPlanarF(&src, &dst, 0)
        }
    } else {
        memcpy(&f, pred.dataPointer, plane * 3 * 4)
    }
    if let r = ref, !looksSane(f, r) { return Data() }
    for i in 0..<plane {
        // model output is BGR (OpenCV order) -> RGB
        rgba[i * 4]     = UInt8(max(0, min(255, f[2 * plane + i] * 255 + 0.5)))
        rgba[i * 4 + 1] = UInt8(max(0, min(255, f[plane + i] * 255 + 0.5)))
        rgba[i * 4 + 2] = UInt8(max(0, min(255, f[i] * 255 + 0.5)))
    }
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    guard let prov = CGDataProvider(data: Data(rgba) as CFData),
          let img = CGImage(width: S, height: S, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: S * 4, space: cs,
                            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: prov,
                            decode: nil, shouldInterpolate: true, intent: .defaultIntent),
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    // The 256² mouth is stretched to the face box (~400 px on the super-resolved clips): a light 3x3 sharpen
    // keeps it as crisp as the face around it instead of reading as a soft patch.
    if w > 300, let data = ctx.data {
        var buf = vImage_Buffer(data: data, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: ctx.bytesPerRow)
        var tmp = [UInt8](repeating: 0, count: ctx.bytesPerRow * h)
        tmp.withUnsafeMutableBytes { t in
            var out = vImage_Buffer(data: t.baseAddress!, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: ctx.bytesPerRow)
            let kern: [Int16] = [0, -1, 0, -1, 8, -1, 0, -1, 0]
            if vImageConvolve_ARGB8888(&buf, &out, nil, 0, 0, kern, 3, 3, 4, nil, vImage_Flags(kvImageEdgeExtend)) == kvImageNoError {
                memcpy(data, t.baseAddress!, ctx.bytesPerRow * h)
            }
        }
    }
    guard let scaled = ctx.makeImage() else { return nil }
    let out = NSMutableData()
    guard let dst = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dst, scaled, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
    return CGImageDestinationFinalize(dst) ? out as Data : nil
}

// round-robin job queues, one serial queue per GPU
let queues = workers.enumerated().map { DispatchQueue(label: "gpu\($0.offset)") }
var next = 0
let melShape = [1, 1, 80, 16]

while let tag = readExactly(1)?.first {
    if tag == UInt8(ascii: "A") || tag == UInt8(ascii: "U") {
        // 'U' = the same encoder inputs as uint8 0..255 (4x less through the pipe; the avatar load was ~2.3 GB of floats)
        let u8 = tag == UInt8(ascii: "U")
        guard let n = readU32() else { break }
        let per = 6 * 256 * 256
        var fresh: [[String: MLFeatureValue]] = Array(repeating: [:], count: Int(n))
        var freshRef: [[Float]] = Array(repeating: [], count: Int(n))
        let group = DispatchGroup()
        for k in 0..<Int(n) {
            var rawOpt: Data?
            if u8 {
                guard let b = readExactly(per) else { exit(0) }
                var f = Data(count: per * 4)
                f.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
                    b.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
                        let o = dst.bindMemory(to: Float.self).baseAddress!
                        vDSP_vfltu8(src.bindMemory(to: UInt8.self).baseAddress!, 1, o, 1, vDSP_Length(per))
                        var sc: Float = 1.0 / 255.0
                        vDSP_vsmul(o, 1, &sc, o, 1, vDSP_Length(per))
                    }
                }
                rawOpt = f
            } else { rawOpt = readExactly(per * 4) }
            guard let raw = rawOpt else { exit(0) }
            // channels 3..5 = the unmasked reference face; keep its B channel's upper half for the sanity check
            let top: [Float] = raw.withUnsafeBytes { b in
                let p = b.bindMemory(to: Float.self); let off = 3 * 256 * 256
                return Array(UnsafeBufferPointer(start: p.baseAddress! + off, count: 128 * 256))
            }
            freshRef[k] = top
            let w = workers[k % workers.count]
            group.enter()
            queues[k % workers.count].async {
                defer { group.leave() }
                do {
                    let face = try raw.withUnsafeBytes { try multiArray([1, 6, 256, 256], $0, 0) }
                    let out = try w.enc.prediction(from: MLDictionaryFeatureProvider(dictionary: ["face": MLFeatureValue(multiArray: face)]))
                    var d: [String: MLFeatureValue] = [:]
                    for name in featNames { d[name] = out.featureValue(for: name) }
                    featsLock.lock(); fresh[k] = d; featsLock.unlock()
                } catch { fail("encoder: \(error)") }
            }
        }
        group.wait()
        featsLock.lock(); feats = fresh; refTop = freshRef; featsLock.unlock()
        send(UInt8(ascii: "A"), [u32(n)])
    } else if tag == UInt8(ascii: "P") {
        guard let hdr = readExactly(16), let melRaw = readExactly(80 * 16 * 4) else { break }
        let (req, base, alpha, w, h) = hdr.withUnsafeBytes { b in
            (b.loadUnaligned(fromByteOffset: 0, as: UInt32.self), b.loadUnaligned(fromByteOffset: 4, as: UInt32.self),
             b.loadUnaligned(fromByteOffset: 8, as: Float.self), Int(b.loadUnaligned(fromByteOffset: 12, as: UInt16.self)),
             Int(b.loadUnaligned(fromByteOffset: 14, as: UInt16.self)))
        }
        healthLock.lock()
        let live = workers.indices.filter { !disabled.contains($0) }
        healthLock.unlock()
        if live.isEmpty { send(UInt8(ascii: "R"), [u32(req), u32(0)]); continue }
        let i = live[next % live.count]; next += 1
        let wk = workers[i]
        queues[i].async {
            do {
                featsLock.lock()
                let f = feats.isEmpty ? nil : feats[Int(base) % feats.count]
                let ref = refTop.isEmpty ? nil : refTop[Int(base) % refTop.count]
                featsLock.unlock()
                guard var d = f else { fail("no avatar"); return }
                d["mel"] = MLFeatureValue(multiArray: try melRaw.withUnsafeBytes { try multiArray(melShape, $0, 0) })
                let a = try MLMultiArray(shape: [1, 1, 1, 1], dataType: .float32); a[0] = NSNumber(value: alpha)
                d["alpha"] = MLFeatureValue(multiArray: a)
                let out = try wk.dec.prediction(from: MLDictionaryFeatureProvider(dictionary: d))
                guard let pred = out.featureValue(for: "pred")?.multiArrayValue, let j = jpeg(pred, w: w, h: h, ref: ref) else { fail("decode failed"); return }
                report(i, ok: !j.isEmpty)
                send(UInt8(ascii: "R"), [u32(req), u32(UInt32(j.count)), j])
                outLock.lock(); fflush(stdout); outLock.unlock()
            } catch { fail("decoder: \(error)") }
        }
    } else { break }
}
for q in queues { q.sync {} }
fflush(stdout)
