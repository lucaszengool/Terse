using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

namespace TerseUIA
{
    class Program
    {
        // Win32 imports
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int count);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
        [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);

        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        const byte VK_CONTROL = 0x11;
        const byte VK_SHIFT = 0x10;
        const byte VK_RETURN = 0x0D;
        const byte VK_BACK = 0x08;
        const byte VK_ESCAPE = 0x1B;
        const byte VK_HOME = 0x24;
        const byte VK_END = 0x23;
        const byte VK_DELETE = 0x2E;
        const uint KEYEVENTF_KEYUP = 0x0002;

        static string Json(Dictionary<string, object> d)
        {
            return JsonSerializer.Serialize(d);
        }

        [STAThread]
        static void Main(string[] args)
        {
            if (args.Length < 1)
            {
                Console.WriteLine(Json(new() { ["error"] = "usage: terse-uia <command> [args...]" }));
                Environment.Exit(1);
            }

            switch (args[0])
            {
                case "check":
                    HandleCheck();
                    break;
                case "read-app":
                    HandleReadApp(args);
                    break;
                case "read-pid":
                    HandleReadPid(args);
                    break;
                case "write-pid":
                    HandleWritePid(args);
                    break;
                case "spellcheck":
                    HandleSpellcheck();
                    break;
                case "enable-uia":
                    HandleEnableUia(args);
                    break;
                case "key-monitor":
                    HandleKeyMonitor(args);
                    break;
                case "focus-check":
                    HandleFocusCheck(args);
                    break;
                case "pick":
                    HandlePick();
                    break;
                default:
                    Console.WriteLine(Json(new() { ["error"] = "unknown command" }));
                    break;
            }
        }

        // ── check ──
        static void HandleCheck()
        {
            // On Windows, UI Automation doesn't require special trust like macOS AX
            Console.WriteLine(Json(new() { ["trusted"] = true }));
        }

        // ── read-app PID [X Y] ──
        static void HandleReadApp(string[] args)
        {
            if (args.Length < 2 || !int.TryParse(args[1], out int pid))
            {
                Console.WriteLine(Json(new() { ["ok"] = false, ["error"] = "bad_args" }));
                return;
            }

            // Strategy 1: focused element
            try
            {
                var focused = AutomationElement.FocusedElement;
                if (focused != null)
                {
                    int focPid = focused.Current.ProcessId;
                    if (focPid == pid || pid == 0)
                    {
                        var controlType = focused.Current.ControlType;
                        if (IsTextElement(controlType))
                        {
                            string value = GetElementText(focused);
                            if (!string.IsNullOrEmpty(value))
                            {
                                Console.WriteLine(Json(new()
                                {
                                    ["ok"] = true,
                                    ["value"] = value,
                                    ["strategy"] = "focused",
                                    ["role"] = controlType.ProgrammaticName
                                }));
                                return;
                            }
                        }

                        // Try finding a text child of the focused element
                        var textChild = FindTextElement(focused, 0);
                        if (textChild != null)
                        {
                            string childValue = GetElementText(textChild);
                            if (!string.IsNullOrEmpty(childValue))
                            {
                                Console.WriteLine(Json(new()
                                {
                                    ["ok"] = true,
                                    ["value"] = childValue,
                                    ["strategy"] = "focused-child",
                                    ["role"] = textChild.Current.ControlType.ProgrammaticName
                                }));
                                return;
                            }
                        }
                    }
                }
            }
            catch { }

            // Strategy 2: position-based (if X Y provided)
            if (args.Length >= 4 && int.TryParse(args[2], out int x) && int.TryParse(args[3], out int y))
            {
                try
                {
                    var pt = new System.Windows.Point(x, y);
                    var el = AutomationElement.FromPoint(pt);
                    if (el != null)
                    {
                        var textEl = FindBestTextElement(el, 0);
                        if (textEl != null)
                        {
                            string val = GetElementText(textEl);
                            if (!string.IsNullOrEmpty(val))
                            {
                                Console.WriteLine(Json(new()
                                {
                                    ["ok"] = true,
                                    ["value"] = val,
                                    ["strategy"] = "position",
                                    ["role"] = textEl.Current.ControlType.ProgrammaticName
                                }));
                                return;
                            }
                        }
                    }
                }
                catch { }
            }

            // Strategy 3: walk the app's windows
            try
            {
                var proc = Process.GetProcessById(pid);
                if (proc.MainWindowHandle != IntPtr.Zero)
                {
                    var appEl = AutomationElement.FromHandle(proc.MainWindowHandle);
                    if (appEl != null)
                    {
                        var textEl = FindBestTextElement(appEl, 0);
                        if (textEl != null)
                        {
                            string val = GetElementText(textEl);
                            if (!string.IsNullOrEmpty(val))
                            {
                                Console.WriteLine(Json(new()
                                {
                                    ["ok"] = true,
                                    ["value"] = val,
                                    ["strategy"] = "window-walk",
                                    ["role"] = textEl.Current.ControlType.ProgrammaticName
                                }));
                                return;
                            }
                        }
                    }
                }
            }
            catch { }

            Console.WriteLine(Json(new() { ["ok"] = false, ["error"] = "no_text_element" }));
        }

        // ── read-pid PID ──
        static void HandleReadPid(string[] args)
        {
            if (args.Length < 2 || !int.TryParse(args[1], out int pid))
            {
                Console.WriteLine(Json(new() { ["ok"] = false, ["error"] = "bad_args" }));
                return;
            }

            try
            {
                var focused = AutomationElement.FocusedElement;
                if (focused != null && focused.Current.ProcessId == pid)
                {
                    var info = GetElementInfo(focused);
                    info["ok"] = true;
                    Console.WriteLine(Json(info));
                    return;
                }
            }
            catch { }

            Console.WriteLine(Json(new() { ["ok"] = false, ["error"] = "no_focused" }));
        }

        // ── write-pid PID ──
        static void HandleWritePid(string[] args)
        {
            if (args.Length < 2 || !int.TryParse(args[1], out int pid))
            {
                Console.WriteLine(Json(new() { ["ok"] = false, ["error"] = "bad_args" }));
                return;
            }

            string text = Console.In.ReadToEnd();

            // Try setting value via UIA ValuePattern
            try
            {
                var focused = AutomationElement.FocusedElement;
                if (focused != null)
                {
                    if (focused.TryGetCurrentPattern(ValuePattern.Pattern, out object pattern))
                    {
                        var vp = (ValuePattern)pattern;
                        if (!vp.Current.IsReadOnly)
                        {
                            vp.SetValue(text);
                            Console.WriteLine(Json(new() { ["ok"] = true, ["method"] = "ValuePattern" }));
                            return;
                        }
                    }
                }
            }
            catch { }

            // Fallback: activate app, Ctrl+A, Ctrl+V via clipboard
            try
            {
                var proc = Process.GetProcessById(pid);
                if (proc.MainWindowHandle != IntPtr.Zero)
                {
                    ShowWindow(proc.MainWindowHandle, 9); // SW_RESTORE
                    SetForegroundWindow(proc.MainWindowHandle);
                    Thread.Sleep(300);
                }
            }
            catch { }

            // Set clipboard and paste
            try
            {
                var thread = new Thread(() => Clipboard.SetText(text));
                thread.SetApartmentState(ApartmentState.STA);
                thread.Start();
                thread.Join();
            }
            catch { }

            Thread.Sleep(50);
            // Ctrl+A
            keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
            keybd_event(0x41, 0, 0, UIntPtr.Zero); // 'A'
            keybd_event(0x41, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            Thread.Sleep(100);
            // Ctrl+V
            keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
            keybd_event(0x56, 0, 0, UIntPtr.Zero); // 'V'
            keybd_event(0x56, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            Thread.Sleep(100);

            Console.WriteLine(Json(new() { ["ok"] = true, ["method"] = "paste" }));
        }

        // ── spellcheck ──
        static void HandleSpellcheck()
        {
            string text = Console.In.ReadToEnd();
            // Windows doesn't have a system-level spellcheck API as easy as macOS NSSpellChecker.
            // Use the WinRT spell checker if available, otherwise pass through.
            // For now, pass through — the hardcoded TYPOS dict in the optimizer handles common cases.
            Console.WriteLine(Json(new()
            {
                ["ok"] = true,
                ["corrected"] = text,
                ["count"] = 0
            }));
        }

        // ── enable-uia PID ──
        static void HandleEnableUia(string[] args)
        {
            if (args.Length < 2 || !int.TryParse(args[1], out int pid))
            {
                Console.WriteLine(Json(new() { ["ok"] = false, ["error"] = "bad_args" }));
                return;
            }

            // On Windows, Electron apps already expose UI Automation by default
            // (unlike macOS where AXManualAccessibility must be toggled).
            // However, VS Code/Cursor may need accessibility settings enabled.
            Console.WriteLine(Json(new() { ["ok"] = true, ["result"] = "windows_uia_native" }));
        }

        // ── focus-check PID ──
        static void HandleFocusCheck(string[] args)
        {
            if (args.Length < 2 || !int.TryParse(args[1], out int pid))
            {
                Console.WriteLine(Json(new() { ["ok"] = false, ["error"] = "bad_args" }));
                return;
            }

            try
            {
                var focused = AutomationElement.FocusedElement;
                if (focused != null)
                {
                    var ct = focused.Current.ControlType;
                    bool isText = IsTextElement(ct);
                    Console.WriteLine(Json(new()
                    {
                        ["ok"] = true,
                        ["isTextInput"] = isText,
                        ["role"] = ct.ProgrammaticName
                    }));
                    return;
                }
            }
            catch { }

            Console.WriteLine(Json(new() { ["ok"] = false, ["isTextInput"] = false, ["error"] = "no_focused" }));
        }

        // ── pick ──
        static void HandlePick()
        {
            Console.WriteLine("{\"status\":\"waiting\"}");
            Console.Out.Flush();

            // Get current foreground window
            IntPtr startHwnd = GetForegroundWindow();

            double waited = 0;
            while (waited < 30.0)
            {
                Thread.Sleep(120);
                waited += 0.12;

                IntPtr curHwnd = GetForegroundWindow();
                if (curHwnd != startHwnd && curHwnd != IntPtr.Zero)
                {
                    Thread.Sleep(400);

                    GetWindowThreadProcessId(curHwnd, out uint pid);
                    var sb = new StringBuilder(256);
                    GetWindowText(curHwnd, sb, 256);
                    string title = sb.ToString();
                    string name = "";
                    try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }

                    // Try to get focused element text
                    string value = "";
                    try
                    {
                        var focused = AutomationElement.FocusedElement;
                        if (focused != null) value = GetElementText(focused) ?? "";
                    }
                    catch { }

                    Console.WriteLine(Json(new()
                    {
                        ["ok"] = true,
                        ["app"] = name,
                        ["pid"] = (int)pid,
                        ["title"] = title,
                        ["value"] = value.Length > 200 ? value[..200] : value,
                        ["role"] = "unknown"
                    }));
                    return;
                }
            }

            Console.WriteLine(Json(new() { ["ok"] = false, ["error"] = "timeout" }));
        }

        // ── key-monitor PID ──
        // Monitors keyboard input for a process using a low-level keyboard hook.
        // Builds a text buffer and emits JSON lines on stdout.
        static void HandleKeyMonitor(string[] args)
        {
            if (args.Length < 2 || !int.TryParse(args[1], out int targetPid))
            {
                Console.WriteLine(Json(new() { ["ok"] = false, ["error"] = "bad_args" }));
                return;
            }

            var state = new KeyMonitorState(targetPid);

            // Install low-level keyboard hook
            IntPtr hookId = IntPtr.Zero;
            var hookProc = new LowLevelKeyboardProc((nCode, wParam, lParam) =>
            {
                if (nCode >= 0)
                {
                    int vkCode = Marshal.ReadInt32(lParam);
                    bool isKeyDown = (int)wParam == 0x0100; // WM_KEYDOWN

                    // Only track when target app is foreground
                    IntPtr fgWnd = GetForegroundWindow();
                    GetWindowThreadProcessId(fgWnd, out uint fgPid);

                    if (fgPid == (uint)state.TargetPid && isKeyDown)
                    {
                        bool ctrl = (Control.ModifierKeys & Keys.Control) != 0;
                        bool alt = (Control.ModifierKeys & Keys.Alt) != 0;

                        if (!ctrl && !alt)
                        {
                            lock (state.Lock)
                            {
                                if (vkCode == VK_BACK)
                                {
                                    if (state.Buffer.Length > 0)
                                        state.Buffer = state.Buffer[..^1];
                                }
                                else if (vkCode == VK_RETURN)
                                {
                                    if (state.SendMode && state.Buffer.Length > 0)
                                    {
                                        string text = state.Buffer;
                                        string escaped = text.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n");
                                        Console.WriteLine($"{{\"enter\":true,\"text\":\"{escaped}\"}}");
                                        Console.Out.Flush();
                                        return CallNextHookEx(hookId, nCode, wParam, lParam);
                                    }
                                    state.Buffer = "";
                                }
                                else if (vkCode == VK_ESCAPE)
                                {
                                    state.Buffer = "";
                                }
                                else if (vkCode >= 0x20 && vkCode <= 0x7E)
                                {
                                    // Printable ASCII
                                    bool shift = (Control.ModifierKeys & Keys.Shift) != 0;
                                    char c = (char)vkCode;
                                    if (!shift && c >= 'A' && c <= 'Z') c = (char)(c + 32);
                                    state.Buffer += c;
                                }
                                state.Changed = true;
                            }
                        }
                    }
                }
                return CallNextHookEx(hookId, nCode, wParam, lParam);
            });

            hookId = SetWindowsHookEx(13, hookProc, GetModuleHandle(null), 0);
            if (hookId == IntPtr.Zero)
            {
                Console.WriteLine(Json(new() { ["ok"] = false, ["error"] = "hook_failed" }));
                return;
            }

            Console.WriteLine("{\"ok\":true,\"monitoring\":true}");
            Console.Out.Flush();

            // Stdin reader thread
            var stdinThread = new Thread(() =>
            {
                string line;
                while ((line = Console.ReadLine()) != null)
                {
                    if (string.IsNullOrEmpty(line)) continue;
                    try
                    {
                        var cmd = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(line);
                        if (cmd == null) continue;

                        string action = cmd.ContainsKey("cmd") ? cmd["cmd"].GetString() : null;

                        if (action == "set-send-mode")
                        {
                            bool on = cmd.ContainsKey("on") && cmd["on"].GetBoolean();
                            lock (state.Lock) { state.SendMode = on; }
                            Console.WriteLine($"{{\"sendMode\":{on.ToString().ToLower()}}}");
                            Console.Out.Flush();
                        }
                        else if (action == "enter")
                        {
                            // Send Enter keystroke
                            keybd_event(VK_RETURN, 0, 0, UIntPtr.Zero);
                            keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                            lock (state.Lock)
                            {
                                state.Buffer = "";
                                state.Changed = true;
                            }
                            Console.WriteLine("{\"enterSent\":true}");
                            Console.Out.Flush();
                        }
                        else if (action == "write")
                        {
                            string text = cmd.ContainsKey("text") ? cmd["text"].GetString() : "";

                            // Set clipboard
                            var clipThread = new Thread(() => Clipboard.SetText(text));
                            clipThread.SetApartmentState(ApartmentState.STA);
                            clipThread.Start();
                            clipThread.Join();
                            Thread.Sleep(10);

                            // Clear line: Home, Shift+End (select all), then Ctrl+V
                            keybd_event(VK_HOME, 0, 0, UIntPtr.Zero);
                            keybd_event(VK_HOME, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                            Thread.Sleep(5);
                            keybd_event(VK_SHIFT, 0, 0, UIntPtr.Zero);
                            keybd_event(VK_END, 0, 0, UIntPtr.Zero);
                            keybd_event(VK_END, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                            keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                            Thread.Sleep(5);
                            // Paste
                            keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
                            keybd_event(0x56, 0, 0, UIntPtr.Zero);
                            keybd_event(0x56, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                            keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                            Thread.Sleep(300);

                            lock (state.Lock)
                            {
                                state.Buffer = text;
                                state.Changed = true;
                            }

                            Console.WriteLine($"{{\"wrote\":true,\"pending\":\"\",\"len\":{text.Length}}}");
                            Console.Out.Flush();
                        }
                    }
                    catch { }
                }
            });
            stdinThread.IsBackground = true;
            stdinThread.Start();

            // Buffer emit thread (every 300ms)
            var emitThread = new Thread(() =>
            {
                while (true)
                {
                    Thread.Sleep(300);
                    if (state.Changed)
                    {
                        state.Changed = false;
                        string text;
                        lock (state.Lock) { text = state.Buffer; }
                        string escaped = text.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n");
                        Console.WriteLine($"{{\"text\":\"{escaped}\",\"len\":{text.Length}}}");
                        Console.Out.Flush();
                    }
                }
            });
            emitThread.IsBackground = true;
            emitThread.Start();

            // Message pump (required for low-level keyboard hook)
            System.Windows.Forms.Application.Run();
        }

        // ── Low-level keyboard hook imports ──
        delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll")]
        static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll")]
        static extern IntPtr GetModuleHandle(string lpModuleName);

        // ── UI Automation helpers ──

        static bool IsTextElement(ControlType ct)
        {
            return ct == ControlType.Edit ||
                   ct == ControlType.Document ||
                   ct == ControlType.Text ||
                   ct == ControlType.ComboBox;
        }

        static string GetElementText(AutomationElement el)
        {
            try
            {
                // Try ValuePattern first
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out object vp))
                {
                    return ((ValuePattern)vp).Current.Value;
                }

                // Try TextPattern for rich text controls
                if (el.TryGetCurrentPattern(TextPattern.Pattern, out object tp))
                {
                    return ((TextPattern)tp).DocumentRange.GetText(-1);
                }

                // Fallback: Name property
                string name = el.Current.Name;
                if (!string.IsNullOrEmpty(name)) return name;
            }
            catch { }

            return null;
        }

        static Dictionary<string, object> GetElementInfo(AutomationElement el)
        {
            var info = new Dictionary<string, object>();
            try
            {
                info["role"] = el.Current.ControlType.ProgrammaticName;
                info["value"] = GetElementText(el) ?? "";

                var rect = el.Current.BoundingRectangle;
                if (!rect.IsEmpty)
                {
                    info["x"] = rect.X;
                    info["y"] = rect.Y;
                    info["width"] = rect.Width;
                    info["height"] = rect.Height;
                }
            }
            catch { }
            return info;
        }

        static AutomationElement FindTextElement(AutomationElement el, int depth)
        {
            if (depth > 10) return null;

            if (IsTextElement(el.Current.ControlType)) return el;

            try
            {
                var children = el.FindAll(TreeScope.Children, Condition.TrueCondition);
                foreach (AutomationElement child in children)
                {
                    var found = FindTextElement(child, depth + 1);
                    if (found != null) return found;
                }
            }
            catch { }

            return null;
        }

        static AutomationElement FindBestTextElement(AutomationElement el, int depth)
        {
            if (depth > 10) return null;

            var ct = el.Current.ControlType;
            if (IsTextElement(ct))
            {
                string val = GetElementText(el);
                if (!string.IsNullOrEmpty(val)) return el;
                return el; // return even if empty
            }

            AutomationElement fallback = null;
            try
            {
                var children = el.FindAll(TreeScope.Children, Condition.TrueCondition);
                foreach (AutomationElement child in children)
                {
                    var found = FindBestTextElement(child, depth + 1);
                    if (found != null)
                    {
                        string val = GetElementText(found);
                        if (!string.IsNullOrEmpty(val)) return found;
                        if (fallback == null) fallback = found;
                    }
                }
            }
            catch { }

            return fallback;
        }

        class KeyMonitorState
        {
            public int TargetPid;
            public string Buffer = "";
            public volatile bool Changed = false;
            public bool SendMode = false;
            public readonly object Lock = new();

            public KeyMonitorState(int pid) { TargetPid = pid; }
        }
    }
}
