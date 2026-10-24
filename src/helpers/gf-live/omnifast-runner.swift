// omnifast-runner.swift — OmniVoice fast mode on the Radeon: models A (full pass → prefix KV cache) and B (target
// tokens against the cached prefix) in one process, so the 117 MB cache never leaves it (omni/omni_coreml.py).
//
// build: src/helpers/gf-live/build-gf-live.sh
// usage: terse-gf-omnifast <omni_A*.mlpackage> <omni_B*.mlpackage>
// stdin (little endian):
//   'A' u32 req, u32 P, float32[1·S_A·1025]          full pass; keep every layer's keys / values of positions < P
//   'B' u32 req, float32[2·T_B·1025], float32[2·(P_B+1)]   target pass (x, meta) against the kept cache
// stdout: 'R' u32 req, u32 n, n bytes (A: none; B: float32[2·T_B·1024] hidden)  |  'E' u32 len, utf8 message
import Foundation
import CoreML
import Metal
import Accelerate

setvbuf(stdout, nil, _IOFBF, 1 << 22)
func u32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
func send(_ parts: [Data]) { var d = Data(); for p in parts { d.append(p) }; FileHandle.standardOutput.write(d); fflush(stdout) }
func fail(_ s: String) { let b = Data(s.utf8); send([Data([UInt8(ascii: "E")]), u32(UInt32(b.count)), b]) }

let stdinH = FileHandle.standardInput
func readExactly(_ n: Int) -> Data? {
    var d = Data(); d.reserveCapacity(n)
    while d.count < n { let c = stdinH.readData(ofLength: n - d.count); if c.isEmpty { return nil }; d.append(c) }
    return d
}
func readU32() -> UInt32? { readExactly(4).map { $0.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) } } }

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

let args = CommandLine.arguments
guard args.count >= 3 else { fail("usage: terse-gf-omnifast <A.mlpackage> <B.mlpackage>"); exit(1) }
let want = ProcessInfo.processInfo.environment["OMNI_GPU"] ?? "amd"
let devs = MTLCopyAllDevices().sorted(by: { !$0.isLowPower && $1.isLowPower })
guard let dev = (want == "intel" ? devs.last : devs.first) else { fail("no GPU"); exit(1) }
let cfg = MLModelConfiguration(); cfg.computeUnits = want == "cpu" ? .cpuOnly : .cpuAndGPU; cfg.preferredMetalDevice = dev
let mA: MLModel, mB: MLModel
do { mA = try MLModel(contentsOf: try compiled(args[1]), configuration: cfg); mB = try MLModel(contentsOf: try compiled(args[2]), configuration: cfg) }
catch { fail("load: \(error)"); exit(1) }
func dims(_ m: MLModel, _ k: String) -> [Int] { (m.modelDescription.inputDescriptionsByName[k]?.multiArrayConstraint?.shape ?? []).map { $0.intValue } }
let SA = dims(mA, "x")[1], TB = dims(mB, "x")[1], PB = dims(mB, "kv")[2], NKV = dims(mB, "kv")[0] * dims(mB, "kv")[1]
FileHandle.standardError.write(Data("omnifast-runner: A S=\(SA), B P=\(PB) T=\(TB) on \(dev.name)\n".utf8))

func array(_ data: Data, _ offset: Int, _ shape: [Int]) throws -> MLMultiArray {
    let n = shape.reduce(1, *)
    let a = try MLMultiArray(shape: shape.map { NSNumber(value: $0) }, dataType: .float32)
    data.withUnsafeBytes { src in _ = memcpy(a.dataPointer, src.baseAddress! + offset, n * 4) }
    return a
}

// the resident cache, laid out as B's input [56, 8, P_B, 128] (positions ≥ P stay zero; meta masks them)
let kv = try! MLMultiArray(shape: dims(mB, "kv").map { NSNumber(value: $0) }, dataType: .float32)
memset(kv.dataPointer, 0, kv.count * 4)

func keep(_ src: MLMultiArray, _ P: Int) {
    // src [56, 8, S_A, 128] (fp16 or fp32, any strides) → kv[:, :, :P] (fp32), the rest zeroed
    let st = src.strides.map { $0.intValue }, D = 128
    let dst = kv.dataPointer.bindMemory(to: Float.self, capacity: kv.count)
    let s0 = dims(mB, "kv")[1]
    for r in 0..<NKV {
        let a = r / s0, b = r % s0
        let o = dst + r * PB * D
        let soff = a * st[0] + b * st[1]
        if src.dataType == .float16 && st[3] == 1 && st[2] == D {
            var sb = vImage_Buffer(data: src.dataPointer + soff * 2, height: 1, width: vImagePixelCount(P * D), rowBytes: P * D * 2)
            var db = vImage_Buffer(data: UnsafeMutableRawPointer(o), height: 1, width: vImagePixelCount(P * D), rowBytes: P * D * 4)
            vImageConvert_Planar16FtoPlanarF(&sb, &db, 0)
        } else {
            for p in 0..<P { for d in 0..<D { o[p * D + d] = src[soff + p * st[2] + d * st[3]].floatValue } }
        }
        memset(o + P * D, 0, (PB - P) * D * 4)
    }
}

while let tag = readExactly(1)?.first {
    guard let req = readU32() else { break }
    if tag == UInt8(ascii: "A") {
        guard let p32 = readU32(), let body = readExactly(SA * 1025 * 4) else { break }
        let P = min(Int(p32), PB)
        autoreleasepool {
            do {
                let out = try mA.prediction(from: try MLDictionaryFeatureProvider(dictionary: ["x": MLFeatureValue(multiArray: try array(body, 0, [1, SA, 1025]))]))
                guard let k = out.featureValue(for: "kv")?.multiArrayValue else { fail("A: no kv"); return }
                keep(k, P)
                send([Data([UInt8(ascii: "R")]), u32(req), u32(0)])
            } catch { fail("A: \(error)") }
        }
    } else if tag == UInt8(ascii: "B") {
        guard let body = readExactly(2 * TB * 1025 * 4 + 2 * (PB + 1) * 4) else { break }
        autoreleasepool {
            do {
                let feats = try MLDictionaryFeatureProvider(dictionary: [
                    "x": MLFeatureValue(multiArray: try array(body, 0, [2, TB, 1025])),
                    "meta": MLFeatureValue(multiArray: try array(body, 2 * TB * 1025 * 4, [2, PB + 1])),
                    "kv": MLFeatureValue(multiArray: kv)])
                let out = try mB.prediction(from: feats)
                guard let h = out.featureValue(for: "h")?.multiArrayValue else { fail("B: no output"); return }
                let n = 2 * TB * 1024
                var f = Data(count: n * 4)
                f.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
                    if h.dataType == .float16 {
                        var s = vImage_Buffer(data: h.dataPointer, height: 1, width: vImagePixelCount(n), rowBytes: n * 2)
                        var d = vImage_Buffer(data: dst.baseAddress, height: 1, width: vImagePixelCount(n), rowBytes: n * 4)
                        vImageConvert_Planar16FtoPlanarF(&s, &d, 0)
                    } else { memcpy(dst.baseAddress, h.dataPointer, n * 4) }
                }
                send([Data([UInt8(ascii: "R")]), u32(req), u32(UInt32(f.count)), f])
            } catch { fail("B: \(error)") }
        }
    } else { break }
}
