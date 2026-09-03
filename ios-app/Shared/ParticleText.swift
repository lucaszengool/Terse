import SwiftUI

#if canImport(UIKit)
import UIKit

/**
 Text drawn as particles, the way the wallpaper engine draws it.

 WHY IT IS BUILT THIS WAY, AND WHY IT CANNOT ANIMATE. The Mac field rasterises a
 string to an offscreen canvas, samples the lit pixels, and gives every one of
 them to a particle. This does exactly that — CoreGraphics into an 8-bit alpha
 buffer, then one dot per lit sample — so the letterforms are the real ones and
 the look matches rather than approximates.

 What it cannot do is move. This renders inside a WidgetKit extension, which
 draws a static snapshot: there is no run loop, no display link, and Live
 Activity animations are capped at two seconds and switched off entirely on an
 Always-On display. So the field flows on the Mac and holds still here. Anything
 promising otherwise would be a lie told sixty times a second.

 ⚠ ONE DOT IS ONE VIEW. A snapshot with a few hundred shapes is fine; a few
 thousand is not, and the extension is killed rather than slowed. `maxDots`
 caps it, and the sampling stride grows until the budget is met — so a long
 string degrades into a coarser field instead of failing to draw.
 */
struct ParticleText: View {
    let text: String
    /// Height of the glyphs in points. Width follows from the string.
    var size: CGFloat = 22
    /// Point size of a single particle. Deliberately smaller than the sampling
    /// grid: the gaps are what make it read as particles rather than as text.
    var dot: CGFloat = 1.6
    var color: Color = .white
    /// The ceiling that keeps the extension alive. 420 is comfortably under
    /// what a Live Activity snapshot will render and enough for ~12 characters.
    var maxDots: Int = 420

    var body: some View {
        let field = ParticleText.sample(text: text, height: size, budget: maxDots)
        // A fixed frame, because the dots are positioned absolutely and a
        // ZStack would otherwise size itself to nothing.
        ZStack(alignment: .topLeading) {
            ForEach(field.dots.indices, id: \.self) { i in
                Circle()
                    .fill(color)
                    .frame(width: dot, height: dot)
                    .offset(x: field.dots[i].x, y: field.dots[i].y)
            }
        }
        .frame(width: field.width, height: field.height, alignment: .topLeading)
        // The whole string is one image to VoiceOver; the dots are decoration.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
    }

    struct Field {
        var dots: [CGPoint]
        var width: CGFloat
        var height: CGFloat
    }

    /// Rasterise, then keep the lit samples.
    ///
    /// Greyscale-only (`.alphaOnly`) because nothing here needs colour and it is
    /// a quarter of the memory of an RGBA buffer — this runs on every Live
    /// Activity update, inside an extension with a hard memory ceiling.
    static func sample(text: String, height: CGFloat, budget: Int) -> Field {
        let font = UIFont.systemFont(ofSize: height, weight: .bold)
        let attrs: [NSAttributedString.Key: Any] = [.font: font]
        let measured = (text as NSString).size(withAttributes: attrs)
        let w = max(1, Int(measured.width.rounded(.up)))
        let h = max(1, Int(measured.height.rounded(.up)))

        guard let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.alphaOnly.rawValue
        ) else {
            return Field(dots: [], width: measured.width, height: measured.height)
        }

        UIGraphicsPushContext(ctx)
        ctx.setFillColor(UIColor.white.cgColor)
        (text as NSString).draw(at: .zero, withAttributes: [
            .font: font, .foregroundColor: UIColor.white,
        ])
        UIGraphicsPopContext()

        guard let buf = ctx.data else {
            return Field(dots: [], width: measured.width, height: measured.height)
        }
        let px = buf.bindMemory(to: UInt8.self, capacity: w * h)

        /* Coarsen until the budget is met rather than truncating the list.
           Truncating drops the right-hand end of the string — the numbers, which
           are the part worth reading. A wider stride thins the whole field
           evenly, which is what the wallpaper does on a lower quality tier. */
        var stride = 2
        var dots: [CGPoint] = []
        while stride < 12 {
            dots.removeAll(keepingCapacity: true)
            var y = 0
            while y < h {
                var x = 0
                while x < w {
                    // 96 of 255: mid-coverage and up. Lower picks up the
                    // antialiasing halo and the glyphs turn to mush.
                    if px[y * w + x] > 96 {
                        dots.append(CGPoint(x: CGFloat(x), y: CGFloat(y)))
                    }
                    x += stride
                }
                y += stride
            }
            if dots.count <= budget { break }
            stride += 1
        }
        if dots.count > budget { dots = Array(dots.prefix(budget)) }

        return Field(dots: dots, width: measured.width, height: measured.height)
    }
}
#endif
