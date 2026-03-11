import Cocoa
import Vision
import ScreenCaptureKit

// Terse OCR Helper
// Commands:
//   capture <x> <y> <width> <height>  — screenshot region + OCR, return text
//   pick                               — wait for user to click, return coords + OCR of surrounding area

let args = CommandLine.arguments

func json(_ d: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: d),
          let s = String(data: data, encoding: .utf8) else { return "{\"ok\":false}" }
    return s
}

func captureRegion(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat) -> CGImage? {
    let rect = CGRect(x: x, y: y, width: w, height: h)

    // Use CGWindowListCreateImage for simple region capture
    guard let image = CGWindowListCreateImage(
        rect,
        .optionOnScreenBelowWindow,
        kCGNullWindowID,
        [.bestResolution, .boundsIgnoreFraming]
    ) else { return nil }

    return image
}

func ocrImage(_ image: CGImage) -> String {
    let requestHandler = VNImageRequestHandler(cgImage: image, options: [:])
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true

    do {
        try requestHandler.perform([request])
    } catch {
        return ""
    }

    guard let observations = request.results else { return "" }

    // Sort by vertical position (top to bottom)
    let sorted = observations.sorted { a, b in
        a.boundingBox.origin.y > b.boundingBox.origin.y
    }

    return sorted.compactMap { obs in
        obs.topCandidates(1).first?.string
    }.joined(separator: "\n")
}

guard args.count >= 2 else {
    print(json(["error": "usage: terse-ocr <capture|pick>"]))
    exit(1)
}

switch args[1] {
case "capture":
    guard args.count >= 6,
          let x = Double(args[2]), let y = Double(args[3]),
          let w = Double(args[4]), let h = Double(args[5]) else {
        print(json(["ok": false, "error": "usage: capture x y w h"]))
        exit(0)
    }

    guard let img = captureRegion(x: CGFloat(x), y: CGFloat(y), w: CGFloat(w), h: CGFloat(h)) else {
        print(json(["ok": false, "error": "screenshot_failed"]))
        exit(0)
    }

    let text = ocrImage(img)
    print(json(["ok": true, "text": text, "width": img.width, "height": img.height]))

case "pick":
    // Wait for click, then capture area around it and OCR
    let startPID = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0

    // Signal ready
    fputs("{\"status\":\"waiting\"}\n", stdout)
    fflush(stdout)

    // Wait for frontmost app to change (user clicked somewhere else)
    var waited = 0.0
    while waited < 30.0 {
        Thread.sleep(forTimeInterval: 0.12)
        waited += 0.12
        guard let cur = NSWorkspace.shared.frontmostApplication else { continue }
        if cur.processIdentifier != startPID {
            Thread.sleep(forTimeInterval: 0.5)

            // Get mouse position
            let mousePos = NSEvent.mouseLocation
            let screenH = NSScreen.main!.frame.height
            let clickX = mousePos.x
            let clickY = screenH - mousePos.y  // Convert to top-left origin

            // Capture a generous area around the click:
            // Assume the input field is roughly 600px wide and 150px tall around the click
            let captureW: CGFloat = 700
            let captureH: CGFloat = 200
            let capX = max(0, clickX - captureW / 2)
            let capY = max(0, clickY - 50)  // A bit above the click

            guard let img = captureRegion(x: capX, y: capY, w: captureW, h: captureH) else {
                print(json(["ok": false, "error": "screenshot_failed"]))
                exit(0)
            }

            let text = ocrImage(img)
            print(json([
                "ok": true,
                "text": text,
                "app": cur.localizedName ?? "?",
                "pid": cur.processIdentifier,
                "clickX": clickX,
                "clickY": clickY,
                "captureX": capX,
                "captureY": capY,
                "captureW": captureW,
                "captureH": captureH,
            ]))
            exit(0)
        }
    }
    print(json(["ok": false, "error": "timeout"]))

default:
    print(json(["error": "unknown command"]))
}
