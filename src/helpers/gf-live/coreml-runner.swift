// coreml-runner.swift — run any Core ML model pinned to the Radeon (Core ML on its own picks the Intel UHD 630).
// Used by OmniVoice fast mode (omni/omni_coreml.py); one process per model.
//
// build: src/helpers/gf-live/build-gf-live.sh
// usage: terse-gf-coreml <model.mlpackage>
// stdin  (little endian), each message:
//   'F' u32 req, u8 n, n × input      run; inputs not sent reuse the last value stored with 'K'
//   'K' u8 n, n × input               store inputs (e.g. a KV cache) for later 'F' calls; no reply
//   input = u8 name_len, name, u8 rank, rank × u32 dims, float32[prod(dims)]
// stdout: 'R' u32 req, u8 n, n × output (same encoding, float32)  |  'E' u32 len, utf8 message
import Foundation
import CoreML
import Metal
import Accelerate

setvbuf(stdout, nil, _IOFBF, 1 << 22)
func u32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
func send(_ d: Data) { FileHandle.standardOutput.write(d); fflush(stdout) }
func fail(_ s: String) { let b = Data(s.utf8); var d = Data([UInt8(ascii: "E")]); d.append(u32(UInt32(b.count))); d.append(b); send(d) }

let stdinH = FileHandle.standardInput
func readExactly(_ n: Int) -> Data? {
    var d = Data(); d.reserveCapacity(n)
    while d.count < n { let c = stdinH.readData(ofLength: n - d.count); if c.isEmpty { return nil }; d.append(c) }
    return d
}
func readU8() -> UInt8? { readExactly(1)?.first }
func readU32() -> UInt32? { readExactly(4).map { $0.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) } } }

func readInput() -> (String, MLMultiArray)? {
    guard let nl = readU8(), let nb = readExactly(Int(nl)), let name = String(data: nb, encoding: .utf8), let rank = readU8() else { return nil }
    var dims: [Int] = []
    for _ in 0..<rank { guard let d = readU32() else { return nil }; dims.append(Int(d)) }
    let n = dims.reduce(1, *)
    guard let body = readExactly(n * 4), let a = try? MLMultiArray(shape: dims.map { NSNumber(value: $0) }, dataType: .float32) else { return nil }
    body.withUnsafeBytes { src in _ = memcpy(a.dataPointer, src.baseAddress!, n * 4) }
    return (name, a)
}

func encode(_ name: String, _ a: MLMultiArray) -> Data {
    var d = Data(); let nb = Data(name.utf8)
    d.append(UInt8(nb.count)); d.append(nb); d.append(UInt8(a.shape.count))
    for s in a.shape { d.append(u32(UInt32(truncating: s))) }
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
    d.append(f); return d
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: terse-gf-coreml <model.mlpackage>"); exit(1) }
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
let want = ProcessInfo.processInfo.environment["COREML_GPU"] ?? "amd"
let devs = MTLCopyAllDevices().sorted(by: { !$0.isLowPower && $1.isLowPower })
guard let dev = (want == "intel" ? devs.last : devs.first) else { fail("no GPU"); exit(1) }
let cfg = MLModelConfiguration(); cfg.computeUnits = want == "cpu" ? .cpuOnly : .cpuAndGPU; cfg.preferredMetalDevice = dev
let model: MLModel
do { model = try MLModel(contentsOf: try compiled(args[1]), configuration: cfg) } catch { fail("load: \(error)"); exit(1) }
let outNames = model.modelDescription.outputDescriptionsByName.keys.sorted()
FileHandle.standardError.write(Data("coreml-runner: \(URL(fileURLWithPath: args[1]).lastPathComponent) on \(dev.name)\n".utf8))

var stored: [String: MLMultiArray] = [:]
while let tag = readU8() {
    if tag == UInt8(ascii: "K") {
        guard let n = readU8() else { break }
        for _ in 0..<n { guard let (k, a) = readInput() else { exit(0) }; stored[k] = a }
        continue
    }
    guard tag == UInt8(ascii: "F"), let req = readU32(), let n = readU8() else { break }
    var feats = stored
    var ok = true
    for _ in 0..<n { guard let (k, a) = readInput() else { ok = false; break }; feats[k] = a }
    if !ok { break }
    autoreleasepool {
        do {
            let out = try model.prediction(from: try MLDictionaryFeatureProvider(dictionary: feats.mapValues { MLFeatureValue(multiArray: $0) }))
            var d = Data([UInt8(ascii: "R")]); d.append(u32(req)); d.append(UInt8(outNames.count))
            for k in outNames { if let a = out.featureValue(for: k)?.multiArrayValue { d.append(encode(k, a)) } }
            send(d)
        } catch { fail("predict: \(error)") }
    }
}
