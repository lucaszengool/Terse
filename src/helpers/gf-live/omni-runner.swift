// omni-runner.swift — OmniVoice's transformer (Core ML fp16) pinned to the Radeon of an Intel MacBook Pro.
//
// OmniVoice (k2-fsa, the TTS behind the Douyin reference) decodes in 32 masked-diffusion steps; each step is one
// bidirectional pass of a 28-layer Qwen3 over [cond, uncond] × S tokens. On this Mac's CPU that is ~40 s/step;
// here it runs on the Radeon (Core ML picks the Intel UHD on its own — pinned with preferredMetalDevice).
//
// build: src/helpers/gf-live/build-gf-live.sh
// usage: terse-gf-omni <backbone.mlpackage>
// stdin  (little endian): 'F' u32 req, u32 B, u32 S, float32[B·S·1025] = inputs_embeds + a validity channel
//                         (1 = real token, 0 = padding; S must be one of the model's enumerated sizes)
// stdout: 'R' u32 req, u32 n, n bytes = float32[B·S·1024] last hidden state  |  'E' u32 len, utf8 message
import Foundation
import CoreML
import Metal
import Accelerate

setvbuf(stdout, nil, _IOFBF, 1 << 22)
let outLock = NSLock()
func send(_ tag: UInt8, _ parts: [Data]) {
    outLock.lock(); defer { outLock.unlock() }
    var d = Data([tag]); for p in parts { d.append(p) }
    FileHandle.standardOutput.write(d)
}
func u32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
func fail(_ s: String) { let b = Data(s.utf8); send(UInt8(ascii: "E"), [u32(UInt32(b.count)), b]); fflush(stdout) }

let stdinH = FileHandle.standardInput
func readExactly(_ n: Int) -> Data? {
    var d = Data(); d.reserveCapacity(n)
    while d.count < n { let c = stdinH.readData(ofLength: n - d.count); if c.isEmpty { return nil }; d.append(c) }
    return d
}
func readU32() -> UInt32? { readExactly(4).map { $0.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) } } }

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: terse-gf-omni <model.mlpackage>"); exit(1) }
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
let want = ProcessInfo.processInfo.environment["OMNI_GPU"] ?? "amd"
let devs = MTLCopyAllDevices().sorted(by: { !$0.isLowPower && $1.isLowPower })
guard let dev = (want == "intel" ? devs.last : devs.first) else { fail("no GPU"); exit(1) }
let cfg = MLModelConfiguration(); cfg.computeUnits = want == "cpu" ? .cpuOnly : .cpuAndGPU; cfg.preferredMetalDevice = dev
let model: MLModel
do { model = try MLModel(contentsOf: try compiled(args[1]), configuration: cfg) } catch { fail("load: \(error)"); exit(1) }
FileHandle.standardError.write(Data("omni-runner: \(dev.name)\n".utf8))

func array(_ data: Data, _ offset: Int, _ shape: [Int]) throws -> MLMultiArray {
    let n = shape.reduce(1, *)
    let a = try MLMultiArray(shape: shape.map { NSNumber(value: $0) }, dataType: .float32)
    data.withUnsafeBytes { src in _ = memcpy(a.dataPointer, src.baseAddress! + offset, n * 4) }
    return a
}

while let tag = readExactly(1)?.first {
    guard tag == UInt8(ascii: "F"), let req = readU32(), let b32 = readU32(), let s32 = readU32() else { break }
    let B = Int(b32), S = Int(s32)
    guard let body = readExactly(B * S * 1025 * 4) else { break }
    autoreleasepool {
        do {
            let feats = try MLDictionaryFeatureProvider(dictionary: [
                "x": MLFeatureValue(multiArray: try array(body, 0, [B, S, 1025]))])
            let out = try model.prediction(from: feats)
            guard let h = out.featureValue(for: "h")?.multiArrayValue else { fail("no output"); return }
            let n = B * S * 1024
            var f = Data(count: n * 4)
            f.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
                if h.dataType == .float16 {
                    var src = vImage_Buffer(data: h.dataPointer, height: 1, width: vImagePixelCount(n), rowBytes: n * 2)
                    var dstb = vImage_Buffer(data: dst.baseAddress, height: 1, width: vImagePixelCount(n), rowBytes: n * 4)
                    vImageConvert_Planar16FtoPlanarF(&src, &dstb, 0)
                } else {
                    memcpy(dst.baseAddress, h.dataPointer, n * 4)
                }
            }
            send(UInt8(ascii: "R"), [u32(req), u32(UInt32(f.count)), f])
            fflush(stdout)
        } catch { fail("predict: \(error)") }
    }
}
fflush(stdout)
