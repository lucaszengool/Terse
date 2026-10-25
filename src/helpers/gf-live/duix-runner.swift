// duix-runner.swift — DUIX's face2face model (DINetV1, Core ML fp16) pinned to the Radeon of an Intel MacBook Pro.
//
// Core ML left to itself runs this model on the Intel UHD 630 (measured 10-19: iGPU 77 % busy, Radeon idle) —
// the same GPU that returns garbage for wav2lip. Like lipsync-runner.swift, the model is pinned with
// preferredMetalDevice; DUIX_GPU=both adds the iGPU as a second worker (frames answered out of order);
// DUIX_GPU=intel / cpu run on the iGPU / CPU only (fallbacks when the hot discrete GPU returns garbage).
//
// build: src/helpers/gf-live/build-gf-live.sh
// usage: terse-gf-duix <dinet_v1_fp16.mlpackage>                       (whole model, one call per frame)
//        terse-gf-duix <duix_p_fp16.mlpackage> <duix_d_fp16.mlpackage> [<melo_dec160_fp16.mlpackage>]
//                                                   (fast split, 10-20; + MeloTTS's decoder, 10-21: 'M' messages)
// stdin  (little endian): 'F' u32 req, float32[3·256·256] source (masked crop, RGB 0..1, CHW),
//                         float32[3·256·256] ref (unmasked crop), float32[256·20] audio window (WeNet BNF, C×T)
//                         'P' u32 req, source, ref                       → per base frame: tz fp16[512·32·32] + ip float32[256]
//                         'D' u32 req, source, audio, tz fp16[512·32·32], ip float32[256]
//                                                                         → RGB uint8 182×212 (rows 74.., cols 18.. of the 256² face)
//                         'M' u32 req, float32[192·160] z (MeloTTS)    → float32[81920] audio, run before queued P / D
// stdout: 'R' u32 req, u32 n, n bytes = RGB uint8 256×256 (HWC) | the P / D / M results above  |  'E' u32 len, utf8 message
import Foundation
import CoreML
import Metal
import Accelerate

setvbuf(stdout, nil, _IOFBF, 1 << 20)
let outLock = NSLock()
func send(_ tag: UInt8, _ parts: [Data]) {
    outLock.lock(); defer { outLock.unlock() }
    var d = Data([tag]); for p in parts { d.append(p) }
    FileHandle.standardOutput.write(d)
}
// Results leave on their own serial queue (10-20): a 115–196 KB result is bigger than the pipe, and while the engine's
// Python is busy (the GIL — e.g. the voice's pyworld pass) the write blocks; the GPU worker must not wait for that.
let outQ = DispatchQueue(label: "out")
func sendAsync(_ tag: UInt8, _ parts: [Data]) { outQ.async { send(tag, parts); fflush(stdout) } }
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
guard args.count >= 2 else { fail("usage: terse-gf-duix <model.mlpackage>"); exit(1) }
func compiled(_ p: String) throws -> URL {
    let src = URL(fileURLWithPath: p)
    if src.pathExtension == "mlmodelc" { return src }
    let dst = src.deletingPathExtension().appendingPathExtension("mlmodelc")
    if let a = try? FileManager.default.attributesOfItem(atPath: dst.path)[.modificationDate] as? Date,
       let b = try? FileManager.default.attributesOfItem(atPath: src.appendingPathComponent("Manifest.json").path)[.modificationDate] as? Date,
       a > b { return dst }
    let tmp = try MLModel.compileModel(at: src)
    try? FileManager.default.removeItem(at: dst)
    try FileManager.default.moveItem(at: tmp, to: dst)
    return dst
}
let modelURL = try compiled(args[1])
let splitURL = args.count >= 3 ? try compiled(args[2]) : nil      // split mode: args[1] = P, args[2] = D
// optional args[3]: MeloTTS's decoder (z [1,192,160] → audio [1,1,81920]). In THIS process on purpose (10-21): two processes
// using Core ML on this Radeon corrupt each other's results even when they take turns (DUIX frames came back garbled while
// Melo's decoder ran in its own runner); one process, one worker, voice jobs first.
let meloURL = args.count >= 4 ? try compiled(args[3]) : nil
let plane = 256 * 256
let BH = 182, BW = 212                                            // D's output band

/// One GPU worker thread; voice (high) jobs run before queued mouth (low) jobs.
final class PrioQueue {
    private let cond = NSCondition()
    private var hi: [() -> Void] = [], lo: [() -> Void] = []
    private var busy = false
    init(_ name: String) {
        let t = Thread { [unowned self] in self.run() }; t.name = name; t.qualityOfService = .userInitiated; t.start()
    }
    func push(high: Bool, _ job: @escaping () -> Void) {
        cond.lock(); if high { hi.append(job) } else { lo.append(job) }; cond.signal(); cond.unlock()
    }
    private func run() {
        while true {
            cond.lock()
            while hi.isEmpty && lo.isEmpty { cond.wait() }
            let job = !hi.isEmpty ? hi.removeFirst() : lo.removeFirst(); busy = true
            cond.unlock()
            autoreleasepool { job() }
            cond.lock(); busy = false; cond.broadcast(); cond.unlock()
        }
    }
    func drain() { cond.lock(); while !(hi.isEmpty && lo.isEmpty) || busy { cond.wait() }; cond.unlock() }
}

final class Worker {
    let dev: MTLDevice, model: MLModel, dmodel: MLModel?, mmodel: MLModel?, queue: PrioQueue
    init(_ dev: MTLDevice, _ i: Int, cpu: Bool = false) throws {
        self.dev = dev
        let cfg = MLModelConfiguration(); cfg.computeUnits = cpu ? .cpuOnly : .cpuAndGPU; cfg.preferredMetalDevice = dev
        model = try MLModel(contentsOf: modelURL, configuration: cfg)
        dmodel = try splitURL.map { try MLModel(contentsOf: $0, configuration: cfg) }
        mmodel = try meloURL.map { try MLModel(contentsOf: $0, configuration: cfg) }
        queue = PrioQueue("gpu\(i)")
    }
}
let want = ProcessInfo.processInfo.environment["DUIX_GPU"] ?? "amd"
var workers: [Worker] = []
let allDevs = MTLCopyAllDevices().sorted(by: { !$0.isLowPower && $1.isLowPower })
for (i, d) in allDevs.enumerated() {                 // amd (default) | both | intel | cpu (garbage fallbacks)
    if want == "cpu" { if i == 0 { do { workers.append(try Worker(d, 0, cpu: true)) } catch { fail("load on CPU: \(error)") } }; continue }
    if want == "intel" ? (!d.isLowPower && allDevs.count > 1) : (want != "both" && d.isLowPower) { continue }
    do { workers.append(try Worker(d, i)) } catch { fail("load on \(d.name): \(error)") }
}
guard !workers.isEmpty else { fail("no GPU worker"); exit(1) }
FileHandle.standardError.write(Data("duix-runner: \(workers.map { $0.dev.name }.joined(separator: " + "))\n".utf8))

func array(_ data: Data, _ offset: Int, _ shape: [Int]) throws -> MLMultiArray {
    let n = shape.reduce(1, *)
    let a = try MLMultiArray(shape: shape.map { NSNumber(value: $0) }, dataType: .float32)
    data.withUnsafeBytes { src in _ = memcpy(a.dataPointer, src.baseAddress! + offset, n * 4) }
    return a
}

func half(_ data: Data, _ offset: Int, _ shape: [Int]) throws -> MLMultiArray {
    let n = shape.reduce(1, *)
    let a = try MLMultiArray(shape: shape.map { NSNumber(value: $0) }, dataType: .float16)
    data.withUnsafeBytes { src in _ = memcpy(a.dataPointer, src.baseAddress! + offset, n * 2) }
    return a
}
/// [1, 3, H, W] float (fp16 or fp32; GPU outputs may pad rows — strides honoured) → HWC RGB uint8
func rgbBytes(_ pred: MLMultiArray, _ n: Int) -> Data {
    let sh = pred.shape.map { $0.intValue }, st = pred.strides.map { $0.intValue }
    let H = sh[2], W = sh[3], isHalf = pred.dataType == .float16, es = isHalf ? 2 : 4
    var f = [Float](repeating: 0, count: 3 * H * W)
    f.withUnsafeMutableBytes { fb in
        for c in 0..<3 { for y in 0..<H {
            let src = pred.dataPointer + (c * st[1] + y * st[2]) * es, dst = fb.baseAddress! + ((c * H + y) * W) * 4
            if isHalf {                            // fp16 → fp32 with vImage (Swift's Float16 is unavailable on x86_64 macOS)
                var s = vImage_Buffer(data: src, height: 1, width: vImagePixelCount(W), rowBytes: W * 2)
                var d = vImage_Buffer(data: dst, height: 1, width: vImagePixelCount(W), rowBytes: W * 4)
                vImageConvert_Planar16FtoPlanarF(&s, &d, 0)
            } else { memcpy(dst, src, W * 4) }
        } }
    }
    let m = H * W
    var rgb = Data(count: m * 3)
    rgb.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
        let o = dst.bindMemory(to: UInt8.self)
        for c in 0..<3 { for i in 0..<m { o[i * 3 + c] = UInt8(max(0, min(255, f[c * m + i] * 255 + 0.5))) } }
    }
    return rgb
}

/// MLMultiArray (fp16 / fp32 / fp64) → float32 bytes
func floatBytes(_ a: MLMultiArray) -> Data {
    let n = a.count
    var f = Data(count: n * 4)
    f.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
        if a.dataType == .float16 {
            var src = vImage_Buffer(data: a.dataPointer, height: 1, width: vImagePixelCount(n), rowBytes: n * 2)
            var dstb = vImage_Buffer(data: dst.baseAddress, height: 1, width: vImagePixelCount(n), rowBytes: n * 4)
            vImageConvert_Planar16FtoPlanarF(&src, &dstb, 0)
        } else if a.dataType == .double {
            let p = a.dataPointer.bindMemory(to: Double.self, capacity: n); let o = dst.bindMemory(to: Float.self)
            for i in 0..<n { o[i] = Float(p[i]) }
        } else { memcpy(dst.baseAddress, a.dataPointer, n * 4) }
    }
    return f
}

var next = 0
let mBytes = 192 * 160 * 4
let inBytes = (2 * 3 * plane + 256 * 20) * 4
let pBytes = 2 * 3 * plane * 4, tzN = 512 * 32 * 32
let dBytes = (3 * plane + 256 * 20) * 4 + tzN * 2 + 256 * 4
while let tag = readExactly(1)?.first {
    guard let req = readU32() else { break }
    if tag == UInt8(ascii: "M") {                                 // MeloTTS decoder: z → audio, ahead of queued mouths
        guard let body = readExactly(mBytes) else { break }
        let w = workers[0]
        guard let mm = w.mmodel else { fail("no Melo decoder loaded"); continue }
        w.queue.push(high: true) {
            do {
                let out = try mm.prediction(from: try MLDictionaryFeatureProvider(dictionary: [
                    "z": MLFeatureValue(multiArray: try array(body, 0, [1, 192, 160]))]))
                guard let a = out.featureValue(for: "audio")?.multiArrayValue else { fail("M: no output"); return }
                let d = floatBytes(a)
                sendAsync(UInt8(ascii: "R"), [u32(req), u32(UInt32(d.count)), d])
            } catch { fail("predict M: \(error)") }
        }
        continue
    }
    if tag == UInt8(ascii: "P") || tag == UInt8(ascii: "D") {
        guard splitURL != nil, let body = readExactly(tag == UInt8(ascii: "P") ? pBytes : dBytes) else { fail("split mode needs P and D models"); break }
        let w = workers[next % workers.count]; next += 1
        w.queue.push(high: false) {
            autoreleasepool {
                do {
                    if tag == UInt8(ascii: "P") {
                        let out = try w.model.prediction(from: try MLDictionaryFeatureProvider(dictionary: [
                            "source": MLFeatureValue(multiArray: try array(body, 0, [1, 3, 256, 256])),
                            "ref": MLFeatureValue(multiArray: try array(body, 3 * plane * 4, [1, 3, 256, 256]))]))
                        guard let tz = out.featureValue(for: "tz")?.multiArrayValue, let ip = out.featureValue(for: "ip")?.multiArrayValue
                        else { fail("P: no output"); return }
                        var d = Data(count: tzN * 2 + 256 * 4)
                        d.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
                            let ts = tz.strides.map { $0.intValue }
                            if tz.dataType == .float16 && ts[1] == 1024 && ts[2] == 32 && ts[3] == 1 { memcpy(dst.baseAddress, tz.dataPointer, tzN * 2) }
                            else if tz.dataType == .float16 {                           // padded rows
                                for r in 0..<(512 * 32) { memcpy(dst.baseAddress! + r * 64, tz.dataPointer + ((r / 32) * ts[1] + (r % 32) * ts[2]) * 2, 64) }
                            } else {                                                    // fp32 → fp16
                                var s = vImage_Buffer(data: tz.dataPointer, height: 1, width: vImagePixelCount(tzN), rowBytes: tzN * 4)
                                var o = vImage_Buffer(data: dst.baseAddress, height: 1, width: vImagePixelCount(tzN), rowBytes: tzN * 2)
                                vImageConvert_PlanarFtoPlanar16F(&s, &o, 0)
                            }
                            let ipo = (dst.baseAddress! + tzN * 2).bindMemory(to: Float.self, capacity: 256)
                            if ip.dataType == .float16 {
                                var s = vImage_Buffer(data: ip.dataPointer, height: 1, width: 256, rowBytes: 512)
                                var o = vImage_Buffer(data: UnsafeMutableRawPointer(ipo), height: 1, width: 256, rowBytes: 1024)
                                vImageConvert_Planar16FtoPlanarF(&s, &o, 0)
                            } else { for i in 0..<256 { ipo[i] = ip[i].floatValue } }
                        }
                        sendAsync(UInt8(ascii: "R"), [u32(req), u32(UInt32(d.count)), d])
                    } else {
                        let o1 = 3 * plane * 4, o2 = o1 + 256 * 20 * 4, o3 = o2 + tzN * 2
                        let out = try w.dmodel!.prediction(from: try MLDictionaryFeatureProvider(dictionary: [
                            "source": MLFeatureValue(multiArray: try array(body, 0, [1, 3, 256, 256])),
                            "audio": MLFeatureValue(multiArray: try array(body, o1, [1, 256, 20])),
                            "tz": MLFeatureValue(multiArray: try half(body, o2, [1, 512, 32, 32])),
                            "ip": MLFeatureValue(multiArray: try array(body, o3, [1, 256]))]))
                        guard let band = out.featureValue(for: "band")?.multiArrayValue else { fail("D: no output"); return }
                        let rgb = rgbBytes(band, BH * BW)
                        sendAsync(UInt8(ascii: "R"), [u32(req), u32(UInt32(rgb.count)), rgb])
                    }
                    fflush(stdout)
                } catch { fail("predict \(Character(UnicodeScalar(tag))): \(error)") }
            }
        }
        continue
    }
    guard tag == UInt8(ascii: "F"), let body = readExactly(inBytes) else { break }
    let w = workers[next % workers.count]; next += 1
    w.queue.push(high: false) {
        autoreleasepool {
            do {
                let feats = try MLDictionaryFeatureProvider(dictionary: [
                    "source": MLFeatureValue(multiArray: try array(body, 0, [1, 3, 256, 256])),
                    "ref": MLFeatureValue(multiArray: try array(body, 3 * plane * 4, [1, 3, 256, 256])),
                    "audio": MLFeatureValue(multiArray: try array(body, 6 * plane * 4, [1, 256, 20]))])
                let out = try w.model.prediction(from: feats)
                guard let pred = out.featureValue(for: "out")?.multiArrayValue else { fail("no output"); return }
                let rgb = rgbBytes(pred, plane)
                sendAsync(UInt8(ascii: "R"), [u32(req), u32(UInt32(rgb.count)), rgb])
                fflush(stdout)
            } catch { fail("predict: \(error)") }
        }
    }
}
for w in workers { w.queue.drain() }
outQ.sync {}
fflush(stdout)
