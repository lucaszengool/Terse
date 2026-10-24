// gf-video.swift — read an idle clip for the live engine: every frame as raw BGR24 + Apple Vision face box per frame.
// One AVFoundation pass, no ffmpeg (users don't have it).
//
// build (universal): see build-gf-live.sh
// usage: terse-gf-video <clip.mp4> <out.bgr> [--bgra]
//   writes all frames (w*h*3 bytes each, BGR, top-down) to out.bgr and prints JSON:
//   {"w":1920,"h":1080,"fps":24,"n":192,"faces":[[x,y,w,h] | null, ...]}   (normalized, origin top-left)
import Foundation
import AVFoundation
import Vision

let args = CommandLine.arguments
guard args.count >= 3 else { FileHandle.standardError.write("usage: terse-gf-video <clip> <out.bgr>\n".data(using: .utf8)!); exit(2) }
let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
let sem = DispatchSemaphore(value: 0)
var track: AVAssetTrack?; var size = CGSize.zero; var fps: Float = 25
Task {
    track = try? await asset.loadTracks(withMediaType: .video).first
    if let t = track { size = (try? await t.load(.naturalSize)) ?? .zero; fps = (try? await t.load(.nominalFrameRate)) ?? 25 }
    sem.signal()
}
sem.wait()
guard let tr = track else { FileHandle.standardError.write("no video track\n".data(using: .utf8)!); exit(1) }
let W = Int(size.width), H = Int(size.height)
let bgra = args.contains("--bgra")              // keep alpha (offline renders of the transparent clips)
let C = bgra ? 4 : 3
let reader = try AVAssetReader(asset: asset)
let out = AVAssetReaderTrackOutput(track: tr, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
reader.add(out); reader.startReading()
FileManager.default.createFile(atPath: args[2], contents: nil)
let fh = FileHandle(forWritingAtPath: args[2])!
var faces: [String] = []
var row = [UInt8](repeating: 0, count: W * H * C)
// one autorelease pool per frame: a bare CLI loop never drains sample buffers / Vision results (HD clips: GBs)
var more = true
while more { autoreleasepool {
    guard let sb = out.copyNextSampleBuffer() else { more = false; return }
    guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    let base = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
    let bpr = CVPixelBufferGetBytesPerRow(pb)
    for y in 0..<H {
        let src = base + y * bpr
        for x in 0..<W {
            let o = (y * W + x) * C
            row[o] = src[x * 4]; row[o + 1] = src[x * 4 + 1]; row[o + 2] = src[x * 4 + 2]     // B G R
            if bgra { row[o + 3] = src[x * 4 + 3] }
        }
    }
    CVPixelBufferUnlockBaseAddress(pb, .readOnly)
    fh.write(Data(row))
    let req = VNDetectFaceRectanglesRequest()
    try? VNImageRequestHandler(cvPixelBuffer: pb, options: [:]).perform([req])
    if let f = (req.results ?? []).max(by: { $0.boundingBox.width < $1.boundingBox.width }) {
        let b = f.boundingBox
        faces.append(String(format: "[%.4f,%.4f,%.4f,%.4f]", b.minX, 1 - b.maxY, b.width, b.height))
    } else { faces.append("null") }
} }
fh.closeFile()
print("{\"w\":\(W),\"h\":\(H),\"fps\":\(fps),\"n\":\(faces.count),\"faces\":[\(faces.joined(separator: ","))]}")
