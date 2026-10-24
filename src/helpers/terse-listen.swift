// terse-listen —— 和 AI 女友说话用的"按住说话"语音识别(Apple Speech,SFSpeechRecognizer)。
//
// 只在用户按住麦克风按钮的那几秒里开麦,松手就关;能在本机识别的语言(zh-CN / en-US 等)
// 强制本机识别 —— 声音不出这台 Mac,也不落盘。
//
// stdin 命令(一行一条):
//   start [locale] [auto=MS]   开麦开始识别,locale 缺省 = 系统语言(例 zh-CN、en-US)。
//                    auto=MS:免按住模式 —— 说完后静音 MS 毫秒就自动收尾(教程 MIN_SILENCE_MS = 1200)
//   stop             关麦,把最后的结果作为 final 发出来
//   quit             退出(stdin 关闭也退出 —— Terse 走了就不留孤儿进程占着麦克风)
//   duplex           (10-22) 她的声音 + 麦克风走同一个带回声消除的音频引擎(见下面 Duplex);duplex_stop 关掉
//   play <turn> <url> / go <turn> / pause / resume / halt   duplex 里播她这句话的声音(url = 引擎 /dha/<turn>)
// stdout 每行一条 JSON:
//   {"status":"ready|listening|stopped|denied|no-mic|unavailable|error|duplex|duplex_off","msg":..,"onDevice":bool}
//   {"pcm":"<base64>"}  duplex:去掉了她声音的麦克风,16 kHz 单声道 s16le,每条 640 个样本(40 ms)
//   {"pos":秒,"turn":n} duplex:她这句话播到哪了(页面上的视频跟着这个时钟)
//   {"partial":"..."}   识别中的临时结果
//   {"final":"..."}     这一句的最终结果(松手后)
//
// 编译(通用二进制):见 src/helpers/build-terse-listen.sh
import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)
let outLock = NSLock()
func emit(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
    outLock.lock(); defer { outLock.unlock() }
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}

final class Listener {
    let engine = AVAudioEngine()
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var recognizer: SFSpeechRecognizer?
    var last = ""
    var finalSent = true
    var tapInstalled = false
    var autoMs = 0
    var silence: DispatchWorkItem?

    /// 免按住模式:每来一次新的识别结果就重新计时,安静 autoMs 毫秒 = 这句说完了。
    func armSilence() {
        guard autoMs > 0 else { return }
        silence?.cancel()
        let w = DispatchWorkItem { [weak self] in self?.stop(sendFinal: true) }
        silence = w
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(autoMs), execute: w)
    }

    func start(locale: String?, auto: Int = 0) {
        autoMs = auto
        stop(sendFinal: false)
        let loc = locale.map { Locale(identifier: $0) } ?? Locale.current
        guard let rec = SFSpeechRecognizer(locale: loc) ?? SFSpeechRecognizer(), rec.isAvailable else {
            emit(["status": "unavailable", "msg": "speech recognition is not available for \(loc.identifier)"]); return
        }
        recognizer = rec
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if rec.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        if #available(macOS 13.0, *) { req.addsPunctuation = true }
        request = req
        last = ""; finalSent = false

        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        guard fmt.channelCount > 0, fmt.sampleRate > 0 else { emit(["status": "no-mic"]); return }
        input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [weak self] buf, _ in self?.request?.append(buf) }
        tapInstalled = true
        engine.prepare()
        do { try engine.start() } catch {
            emit(["status": "error", "msg": "microphone: \(error.localizedDescription)"]); cleanup(); return
        }
        task = rec.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if let r = result {
                let t = r.bestTranscription.formattedString
                if t != self.last { self.last = t; emit(["partial": t]); DispatchQueue.main.async { self.armSilence() } }
                if r.isFinal { self.sendFinal() }
            }
            if error != nil { self.sendFinal() }
        }
        emit(["status": "listening", "onDevice": req.requiresOnDeviceRecognition, "locale": rec.locale.identifier])
    }

    func sendFinal() {
        if finalSent { return }
        finalSent = true
        emit(["final": last])
    }

    func stop(sendFinal: Bool) {
        silence?.cancel(); silence = nil
        guard request != nil else { return }
        if engine.isRunning { engine.stop() }
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
        request?.endAudio()
        if sendFinal {
            // 识别器在 endAudio 之后还会回一次 isFinal;等它最多 1.5 秒,不来就用手里最后的临时结果
            let deadline = Date().addingTimeInterval(1.5)
            while !finalSent && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
            self.sendFinal()
        } else {
            finalSent = true
        }
        cleanup()
        emit(["status": "stopped"])
    }

    func cleanup() {
        task?.cancel(); task = nil; request = nil
        if tapInstalled { engine.inputNode.removeTap(onBus: 0); tapInstalled = false }
    }
}

let listener = Listener()

// ── duplex (10-22, user: 让 app 里的语音输入也照 beiyege 那个 repo:说话就能打断她,而且不会被她自己的声音打断) ──
// Her voice plays HERE, through the same AVAudioEngine that records the mic, with voice processing on (VoiceProcessingIO):
// macOS's echo canceller takes what this engine plays as its reference (WWDC19 "What's new in AVAudioEngine" — voice
// processing removes the device's own output from the input; audio another process plays is not its reference, which is why
// the wallpaper can't keep playing her voice itself). The cleaned mic goes out as the repo's worklet makes it — 16 kHz mono
// s16le, 640 samples (40 ms) a line — for the page's recorder (gf-mic.js: noise gate, 1.8 s endpointing, /stt, /vad).
final class Duplex: NSObject, URLSessionDataDelegate {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let herFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
    var src: [Float] = []                 // mic samples (hardware rate) not yet turned into 16 kHz
    var frac = 0.0                         // where the next 16 kHz sample falls in src
    var acc: [Int16] = []
    var running = false
    var turn = -1
    var session: URLSession?
    var task: URLSessionDataTask?
    var pending = Data()
    var posTimer: DispatchSourceTimer?

    func start() {
        if running { emit(["status": "duplex"]); return }
        let input = engine.inputNode
        do { try input.setVoiceProcessingEnabled(true) }                 // the output side goes through it too
        catch { emit(["status": "error", "msg": "voice processing: \(error.localizedDescription)"]); return }
        if #available(macOS 14.0, *) {                                    // don't turn the rest of the Mac down while she listens
            input.voiceProcessingOtherAudioDuckingConfiguration =
                AVAudioVoiceProcessingOtherAudioDuckingConfiguration(enableAdvancedDucking: false, duckingLevel: .min)
        }
        // with voice processing the output side must be mono (measured 10-22 on a 2019 MacBook Pro: the default stereo
        // mixer → speakers connection fails to initialize, -10875); the mixer turns her 24 kHz voice into the hardware rate
        let hw = engine.outputNode.outputFormat(forBus: 0)
        engine.connect(engine.mainMixerNode, to: engine.outputNode,
                       format: AVAudioFormat(standardFormatWithSampleRate: hw.sampleRate > 0 ? hw.sampleRate : 48000, channels: 1))
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: herFmt)
        let fmt = input.outputFormat(forBus: 0)
        guard fmt.channelCount > 0, fmt.sampleRate > 0 else { emit(["status": "no-mic"]); return }
        input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { [weak self] buf, _ in self?.mic(buf) }
        engine.prepare()
        do { try engine.start() } catch {
            input.removeTap(onBus: 0)
            emit(["status": "error", "msg": "microphone: \(error.localizedDescription)"]); return
        }
        running = true
        emit(["status": "duplex", "rate": fmt.sampleRate, "channels": Int(fmt.channelCount)])
    }

    /// the tap's thread. Voice processing hands over its cleaned mono mic copied into every channel (6 here); channel 0 →
    /// 16 kHz the way the repo's worklet does it: 48 kHz = the mean of each 3 samples, any other rate linear interpolation
    /// (10-22: AVAudioConverter turned the 6-channel buffer, which has no channel layout, into silence)
    func mic(_ buf: AVAudioPCMBuffer) {
        guard let ch = buf.floatChannelData, buf.frameLength > 0 else { return }
        src.append(contentsOf: UnsafeBufferPointer(start: ch[0], count: Int(buf.frameLength)))
        let r = buf.format.sampleRate / 16000
        var out: [Int16] = []; out.reserveCapacity(Int(Double(src.count) / r) + 1)
        func i16(_ v: Float) -> Int16 { let c = max(-1, min(1, v)); return Int16(c < 0 ? c * 32768 : c * 32767) }
        if abs(r - 3) < 1e-6 {
            var i = 0
            while i + 3 <= src.count { out.append(i16((src[i] + src[i + 1] + src[i + 2]) / 3)); i += 3 }
            src.removeFirst(i)
        } else {
            while frac + 1 < Double(src.count) {
                let i = Int(frac), t = Float(frac - Double(i))
                out.append(i16(src[i] + (src[i + 1] - src[i]) * t)); frac += r
            }
            let used = min(Int(frac), src.count); src.removeFirst(used); frac -= Double(used)
        }
        acc.append(contentsOf: out)
        while acc.count >= 640 {
            let d = acc.withUnsafeBufferPointer { Data(buffer: UnsafeBufferPointer(rebasing: $0[0..<640])) }
            acc.removeFirst(640)
            emit(["pcm": d.base64EncodedString()])
        }
    }

    /// her reply's voice, streamed while the engine makes it (raw s16le 24 kHz mono); scheduled now, heard at go
    func play(_ t: Int, _ url: URL) {
        halt()
        turn = t; pending = Data()
        let s = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        session = s; task = s.dataTask(with: url); task?.resume()
    }

    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, dataTask === self.task else { return }
            self.pending.append(data)
            let n = self.pending.count / 2
            guard n >= 480, let b = AVAudioPCMBuffer(pcmFormat: self.herFmt, frameCapacity: AVAudioFrameCount(n)) else { return }
            b.frameLength = AVAudioFrameCount(n)
            let f = b.floatChannelData![0]
            self.pending.withUnsafeBytes { raw in
                let v = raw.bindMemory(to: Int16.self)
                for i in 0..<n { f[i] = Float(v[i]) / 32768 }
            }
            self.pending.removeFirst(n * 2)
            self.player.scheduleBuffer(b, completionHandler: nil)
        }
    }

    func go(_ t: Int) {
        guard t == turn, running else { return }
        player.play()
        posTimer?.cancel()
        let tm = DispatchSource.makeTimerSource(queue: .main)
        tm.schedule(deadline: .now(), repeating: .milliseconds(100))
        tm.setEventHandler { [weak self] in
            guard let self = self, self.player.isPlaying, let nt = self.player.lastRenderTime,
                  let pt = self.player.playerTime(forNodeTime: nt) else { return }
            emit(["pos": Double(pt.sampleTime) / pt.sampleRate, "turn": self.turn])
        }
        tm.resume(); posTimer = tm
    }

    func pause() { player.pause() }
    func resume() { if running && turn >= 0 { player.play() } }

    func halt() {
        task?.cancel(); task = nil
        session?.invalidateAndCancel(); session = nil
        player.stop(); posTimer?.cancel(); posTimer = nil
        turn = -1; pending = Data()
    }

    func stop() {
        halt()
        if running { engine.inputNode.removeTap(onBus: 0); engine.stop(); running = false }
        acc.removeAll(); src.removeAll(); frac = 0
        emit(["status": "duplex_off"])
    }
}

let duplex = Duplex()

func authorizeMic(_ done: @escaping (Bool) -> Void) {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: done(true)
    case .notDetermined: AVCaptureDevice.requestAccess(for: .audio) { ok in
        if !ok { emit(["status": "denied", "msg": "microphone permission"]) }
        done(ok) }
    default: emit(["status": "denied", "msg": "microphone permission"]); done(false)
    }
}

func authorize(_ done: @escaping (Bool) -> Void) {
    SFSpeechRecognizer.requestAuthorization { st in
        guard st == .authorized else { emit(["status": "denied", "msg": "speech recognition permission: \(st.rawValue)"]); done(false); return }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: done(true)
        case .notDetermined: AVCaptureDevice.requestAccess(for: .audio) { ok in
            if !ok { emit(["status": "denied", "msg": "microphone permission"]) }
            done(ok) }
        default: emit(["status": "denied", "msg": "microphone permission"]); done(false)
        }
    }
}

// stdin 读命令放后台线程,识别回调和 RunLoop 在主线程
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine() {
        let parts = line.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 1).map(String.init)
        guard let cmd = parts.first else { continue }
        DispatchQueue.main.async {
            switch cmd {
            case "start":
                var loc: String? = nil; var auto = 0
                for tok in (parts.count > 1 ? parts[1] : "").split(separator: " ").map(String.init) {
                    if tok.hasPrefix("auto=") { auto = Int(tok.dropFirst(5)) ?? 0 } else if !tok.isEmpty { loc = tok }
                }
                authorize { ok in if ok { DispatchQueue.main.async { listener.start(locale: loc, auto: auto) } } }
            case "stop": listener.stop(sendFinal: true)
            case "quit": listener.stop(sendFinal: false); duplex.stop(); exit(0)
            case "duplex":
                listener.stop(sendFinal: false)
                authorizeMic { ok in if ok { DispatchQueue.main.async { duplex.start() } } }
            case "duplex_stop": duplex.stop()
            case "play":
                let a = (parts.count > 1 ? parts[1] : "").split(separator: " ").map(String.init)
                if a.count == 2, let t = Int(a[0]), let u = URL(string: a[1]) { duplex.play(t, u) }
            case "go": if parts.count > 1, let t = Int(parts[1].trimmingCharacters(in: .whitespaces)) { duplex.go(t) }
            case "pause": duplex.pause()
            case "resume": duplex.resume()
            case "halt": duplex.halt()
            default: break
            }
        }
    }
    DispatchQueue.main.async { listener.stop(sendFinal: false); duplex.stop(); exit(0) }
}

emit(["status": "ready"])
RunLoop.main.run()
