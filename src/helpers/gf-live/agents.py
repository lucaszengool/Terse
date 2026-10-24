"""Her brain can be a coding agent on this Mac (user 10-22: "一键连接本地 claude code / codex / deepseek 当作 brain 的回复，但是
voice，DUIX 完全不变，只是读取的是 claude code / codex 的回复。包括语音的时候也一样"): the same persona and the same sentence →
voice → DUIX pipeline as the local brain (engine /chat) — only the words stream out of the agent's own command line.

  claude  Claude Code   claude -p, stream-json + partial messages (a token stream), no tools, no MCP, no session files
  codex   Codex         codex exec --json, read-only sandbox, ephemeral (the reply arrives as one message)
  dsh     DeepSeek      dsh --profile headless (prints the reply)

Finding them: where Terse's gf_agent_bin looks (girlfriend.rs) — Homebrew, npm-global, ~/.local/bin, the CLI inside the Claude
desktop app / Codex.app, then the login shell. Connecting (check): Claude Code not logged in → `claude auth login` opens the
browser on Anthropic's 授权 page and finishes by itself once the user clicks (user 10-22: "make claude auto login and user just
click"); an agent whose config routes through Terse's proxy (:7860) gets the proxy started if it isn't running, as Terse does
at launch."""
import glob, json, os, queue, re, socket, subprocess, threading, time

HOME = os.path.expanduser("~")
GF_HOME = os.path.expanduser(os.environ.get("GF_HOME", "~/.terse/gf-live"))
LABEL = {"claude": "Claude Code", "codex": "Codex", "dsh": "DeepSeek"}
HOST = {"claude": "Anthropic", "codex": "OpenAI", "dsh": "DeepSeek"}
PROXY_PORT = 7860
CWD = os.path.join(HOME, ".terse", "gf-chat")             # an empty folder: no CLAUDE.md / AGENTS.md of a project leaks in
# spoken replies: the persona's own format (【情绪】 + 两三句), nothing a voice can't say
RULES = "这是语音对话：只写你接下来说出口的话（照上面的格式），不要解释、不要旁白、不要用任何工具、不要写代码或链接。"

_bins, _lock = {}, threading.Lock()
_login = {"p": None, "url": None}


class AgentError(Exception):
    def __init__(self, msg, hint=None):
        super().__init__(msg); self.hint = hint


def child_env(bin_):
    """the agent's own environment: its folder + node first on PATH (dsh is a node script; Homebrew's node is newer than the
    pkg one in /usr/local/bin), and none of a host Claude Code session's variables — an engine started from inside one would
    otherwise make the CLI a nested child of that session (CLAUDECODE, CLAUDE_CODE_*); ANTHROPIC_BASE_URL comes from the
    CLI's own settings.json"""
    env = {k: v for k, v in os.environ.items() if not (k.startswith("CLAUDE") or k == "ANTHROPIC_BASE_URL")}
    if os.name == "nt":                               # Windows: npm's global bin (claude.cmd …) and node itself
        path = [os.path.dirname(bin_), os.path.join(os.environ.get("APPDATA", ""), "npm"),
                os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "nodejs"), os.path.join(HOME, ".local", "bin")]
        env["PATH"] = os.pathsep.join(path + [env.get("PATH") or ""])
        return env
    nvm = sorted(glob.glob(os.path.join(HOME, ".nvm/versions/node/*/bin")))
    path = [os.path.dirname(bin_), "/usr/local/opt/node/bin", "/opt/homebrew/bin", "/usr/local/bin", os.path.join(HOME, ".npm-global/bin")]
    env["PATH"] = ":".join(path + nvm[-1:] + [env.get("PATH") or "/usr/bin:/bin:/usr/sbin:/sbin"])
    return env


def _vkey(p):
    return tuple(int(x) if x.isdigit() else 0 for x in re.split(r"[.\-]", os.path.basename(p)))


def _cands(name):
    if os.name == "nt":                               # Windows: npm installs NAME.cmd; Claude Code's native installer NAME.exe
        npm = os.path.join(os.environ.get("APPDATA", ""), "npm")
        c = [os.path.join(npm, f"{name}.cmd"), os.path.join(npm, f"{name}.exe"), os.path.join(HOME, ".local", "bin", f"{name}.exe")]
        if name == "claude": c.append(os.path.join(HOME, ".claude", "local", "claude.cmd"))
        return c
    c = [os.path.join(d, name) for d in ("/opt/homebrew/bin", "/usr/local/bin", os.path.join(HOME, ".npm-global/bin"), os.path.join(HOME, ".local/bin"))]
    if name == "claude":
        c.append(os.path.join(HOME, ".claude/local/claude"))
        for v in sorted(glob.glob(os.path.join(HOME, "Library/Application Support/Claude/claude-code/*")), key=_vkey, reverse=True):
            c += glob.glob(os.path.join(v, "*", "claude.app/Contents/MacOS/claude"))      # the CLI the Claude desktop app ships
    if name == "codex": c.append("/Applications/Codex.app/Contents/Resources/codex")
    return c


def _version(p):
    """runs at all (npm's claude is a shell that only prints "native binary not installed" without its native package) →
    its version line; Codex.app's cold start takes ~10 s"""
    try:
        r = subprocess.run([p, "--version"], capture_output=True, text=True, timeout=25, env=child_env(p), stdin=subprocess.DEVNULL)
        line = ((r.stdout or r.stderr).strip().splitlines() or [""])[0]
        return line[:60] if r.returncode == 0 else None
    except Exception: return None


def _shell_which(name):
    """the user's login shells (an app started from Finder has only /usr/bin:/bin); slow with heavy rc files, so last"""
    if os.name == "nt":                               # Windows: PATH + PATHEXT, as the shell would resolve it
        import shutil
        return shutil.which(name, path=child_env(os.path.join(HOME, name))["PATH"])
    for sh, flag in (("/bin/zsh", "-lc"), ("/bin/bash", "-lic")):
        try:
            out = subprocess.run([sh, flag, f"command -v {name}"], capture_output=True, text=True, timeout=8, stdin=subprocess.DEVNULL).stdout
            p = (out.strip().splitlines() or [""])[-1].strip()
            if p.startswith("/") and os.path.isfile(p): return p
        except Exception: pass
    return None


def find(name):
    """(path, version) of a working CLI, or (None, None); cached while the file exists"""
    with _lock:
        hit = _bins.get(name)
        if hit and os.path.exists(hit[0]): return hit
    for p in [os.environ.get(f"GF_AGENT_BIN_{name.upper()}") or ""] + _cands(name):     # dev: a stand-in CLI first
        if not p: continue
        if os.path.isfile(p) and os.access(p, os.X_OK):
            v = _version(p)
            if v is not None:
                with _lock: _bins[name] = (p, v)
                return p, v
    p = _shell_which(name)
    v = _version(p) if p else None
    if v is not None:
        with _lock: _bins[name] = (p, v)
        return p, v
    return None, None


def _port_open(port):
    s = socket.socket(); s.settimeout(0.5)
    try: s.connect(("127.0.0.1", port)); return True
    except Exception: return False
    finally: s.close()


def _proxy_wanted(name):
    """does this agent's own config send it through Terse's routing proxy?"""
    try:
        if name == "claude":
            env = json.load(open(os.path.join(HOME, ".claude/settings.json"))).get("env") or {}
            return f":{PROXY_PORT}" in str(env.get("ANTHROPIC_BASE_URL") or "")
        if name == "codex": return f"127.0.0.1:{PROXY_PORT}" in open(os.path.join(HOME, ".codex/config.toml")).read()
        if name == "dsh": return any(f":{PROXY_PORT}" in open(f).read() for f in glob.glob(os.path.join(HOME, ".dsh/profiles/headless/*.yml")))
    except Exception: pass
    return False


def ensure_proxy(name):
    """Terse's proxy (~/.terse/terse-local-proxy.js) is what the agent's config points at; Terse starts it at launch — start it
    the same way if it isn't running, or every reply would fail with "connection refused" """
    if not _proxy_wanted(name) or _port_open(PROXY_PORT): return
    script = os.path.join(HOME, ".terse", "terse-local-proxy.js")
    node = next((n for n in ["/usr/local/opt/node/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"]
                 + sorted(glob.glob(os.path.join(HOME, ".nvm/versions/node/*/bin/node")))[-1:] if os.path.exists(n)), None)
    if not (os.path.exists(script) and node): return
    subprocess.Popen([node, script, "--port", str(PROXY_PORT)], stdout=open(os.path.join(GF_HOME, "proxy.log"), "a"),
                     stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    for _ in range(30):
        if _port_open(PROXY_PORT): return
        time.sleep(0.1)


def hint(name, err):
    """what the user can do about it, in a sentence"""
    e = str(err)
    if e == "missing": return f"这台 Mac 上没找到 {LABEL[name]}。"
    if re.search(r"Insufficient Balance|QUOTA|insufficient_quota|exceeded your current quota|credit balance", e, re.I):
        return {"dsh": "DeepSeek 余额不足：去 platform.deepseek.com 充值后再点连接。",
                "codex": "OpenAI 的额度用完了：充值后再点连接。"}.get(name, "账号额度用完了。")
    if re.search(r"OAuth|authenticat|not logged|log ?in|401|unauthori|invalid api key|api key", e, re.I):
        return {"claude": "Claude Code 还没登录：点「连接」会打开浏览器，在那里点「授权」就好。",
                "codex": "Codex 还没登录：在终端运行 codex login。",
                "dsh": "DeepSeek 的 API key 不对：在 dsh web 的设置里重新填一次。"}[name]
    if re.search(r"TRANSPORT|ECONN|refused|disconnect|TLS|timed? ?out|network|Reconnecting|ENOTFOUND|getaddrinfo|502|503|unreachable", e, re.I):
        return f"连不上 {HOST[name]} 的服务器：检查网络 / VPN 后再点连接。"
    return e[:200]


def prompt_of(msgs):
    """engine chat messages (system persona + turns) → (persona, transcript) for a command-line agent"""
    persona = re.sub(r"\s*/no_think\s*$", "", msgs[0]["content"]).strip() + "\n\n" + RULES
    turns = [("他：" if m["role"] == "user" else "你：") + str(m["content"]).strip() for m in msgs[1:][-17:]]   # 8 exchanges + this one
    return persona, "\n".join(turns) + "\n你："


def _args(name, bin_, msgs, model):
    persona, transcript = prompt_of(msgs)
    if name == "claude":
        return [bin_, "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence",
                "--tools", "", "--strict-mcp-config", "--model", model or "haiku", "--system-prompt", persona, transcript]
    if name == "codex":
        a = [bin_, "exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-c", 'model_reasoning_effort="low"']
        return a + (["-m", model] if model else []) + [persona + "\n\n" + transcript]
    return [bin_, "--profile", "headless", persona + "\n\n" + transcript]


def stream(name, msgs, model=None, stop=None, first_timeout=60, total_timeout=150):
    """yield her words as the agent writes them; `stop` (threading.Event) set or the generator closed → the agent is killed"""
    bin_, _ = find(name)
    if not bin_: raise AgentError(f"{name} is not installed", hint(name, "missing"))
    ensure_proxy(name)
    os.makedirs(CWD, exist_ok=True)
    p = subprocess.Popen(_args(name, bin_, msgs, model), cwd=CWD, env=child_env(bin_), stdin=subprocess.DEVNULL,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    q, err = queue.Queue(), []

    def read_out():
        if name == "dsh":                                 # plain text: pass it on as it comes
            while True:
                b = os.read(p.stdout.fileno(), 4096)
                if not b: break
                q.put(("raw", b))
        else:
            for line in p.stdout: q.put(("line", line))
        q.put(("eof", None))

    def read_err():
        for line in p.stderr: err.append(line.decode("utf-8", "replace").strip())
    threading.Thread(target=read_out, daemon=True).start(); threading.Thread(target=read_err, daemon=True).start()
    t0 = time.time(); said = False; held = ""; errs = []; dec = b""
    try:
        while True:
            if stop is not None and stop.is_set(): return
            if time.time() - t0 > (total_timeout if said else first_timeout):
                raise AgentError(f"{name}: no answer within {int(time.time() - t0)}s", hint(name, "timed out"))
            try: kind, data = q.get(timeout=0.1)
            except queue.Empty: continue
            if kind == "eof": break
            if kind == "raw":
                dec += data
                try: txt = dec.decode("utf-8"); dec = b""
                except UnicodeDecodeError: continue           # a multi-byte character split across reads
                txt = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", txt)
                if txt.strip(): said = True                  # dsh prints a bare newline before it fails: that isn't a reply
                if txt: yield txt
                continue
            try: d = json.loads(data)
            except Exception: continue
            t = d.get("type")
            if name == "claude":
                if t == "stream_event":
                    ev = d.get("event") or {}
                    if ev.get("type") == "content_block_delta" and (ev.get("delta") or {}).get("type") == "text_delta":
                        said = True; yield ev["delta"]["text"]
                elif t == "assistant" and not said:            # no partials: hold it — a failed login arrives this way too
                    held += "".join(c.get("text", "") for c in (d.get("message") or {}).get("content") or [] if c.get("type") == "text")
                elif t == "result":
                    if d.get("is_error"): raise AgentError(str(d.get("result") or "error"), hint(name, d.get("result")))
                    if not said and held: said = True; yield held
            elif name == "codex":
                it = d.get("item") or {}
                if t == "item.completed" and it.get("type") == "agent_message" and it.get("text"):
                    said = True; yield it["text"]
                elif t == "error":
                    errs.append(str(d.get("message") or ""))
                    # it retries 5 × 2 with back-off (~2 min of silence) — a transport failure ends this turn now, with the hint
                    if len(errs) >= 3 or re.search(r"disconnected|refused|error sending|TLS|502|503|timed out", errs[-1], re.I):
                        raise AgentError(errs[-1], hint(name, errs[-1]))
                elif t == "turn.failed":
                    m = str((d.get("error") or {}).get("message") or (errs[-1] if errs else "turn failed"))
                    raise AgentError(m, hint(name, m))
        p.wait(timeout=5)
        if not said:
            why = next((l for l in reversed(err) if l and "Reconnecting" not in l), "") or f"exit {p.returncode}"
            raise AgentError(why[:300], hint(name, why))
    finally:
        if p.poll() is None:
            try: os.killpg(p.pid, 9)
            except Exception: p.kill()


def claude_logged_in(bin_):
    try:
        out = subprocess.run([bin_, "auth", "status", "--json"], capture_output=True, text=True, timeout=20, env=child_env(bin_),
                             stdin=subprocess.DEVNULL).stdout
        return bool(json.loads(out).get("loggedIn"))
    except Exception: return None                           # unknown: try a reply and let it tell


def claude_login(bin_):
    """`claude auth login` opens the browser on Anthropic's 授权 page and waits for its callback on localhost — the user only
    clicks Authorize; the CLI stores the login itself. It draws a terminal UI, so it runs on a pseudo-terminal (a wide one:
    the authorize URL must not wrap), and gets an Enter if it asks for one. One at a time; returns the URL it printed (a link
    in case no browser opened)"""
    if os.name == "nt":                               # Windows: no pty — its own console window, which opens the browser
        p = _login["p"]
        if p is not None and p.poll() is None: return _login["url"]
        p = subprocess.Popen([bin_, "auth", "login", "--claudeai"], env=child_env(bin_),
                             creationflags=0x00000010)    # CREATE_NEW_CONSOLE (the engine's no-window default yields to it)
        _login.update(p=p, url=None, out="")
        return None
    import fcntl, pty, struct, termios
    p = _login["p"]
    if p is not None and p.poll() is None: return _login["url"]
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 2000, 0, 0))
    env = dict(child_env(bin_), COLUMNS="2000", LINES="50", TERM="xterm-256color")
    p = subprocess.Popen([bin_, "auth", "login", "--claudeai"], env=env, stdin=slave, stdout=slave, stderr=slave,
                         start_new_session=True, close_fds=True)
    os.close(slave)
    _login.update(p=p, url=None, out="")

    def read():
        entered = False
        while True:
            try: b = os.read(master, 4096)
            except OSError: break
            if not b: break
            _login["out"] = (_login["out"] + b.decode("utf-8", "replace"))[-12000:]
            plain = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07", "", _login["out"])
            m = re.search(r"https://[^\s\x1b]+", plain)
            if m and not _login["url"]: _login["url"] = m.group(0).rstrip(".,)")
            if not entered and re.search(r"press enter|press return|按回车", plain, re.I):
                entered = True
                try: os.write(master, b"\r")
                except OSError: pass
        try: os.close(master)
        except OSError: pass
    threading.Thread(target=read, daemon=True).start()
    for _ in range(80):
        if _login["url"] or p.poll() is not None: break
        time.sleep(0.1)
    return _login["url"]


def check(name, model=None):
    """一键连接: installed → logged in (Claude Code: start the browser login, call again until it's done) → one tiny real reply"""
    bin_, ver = find(name)
    if not bin_: return {"ok": False, "id": name, "label": LABEL[name], "error": "missing", "hint": hint(name, "missing")}
    out = {"id": name, "label": LABEL[name], "bin": bin_, "version": ver}
    if name == "claude" and claude_logged_in(bin_) is False:
        url = claude_login(bin_)
        if _login["p"] is not None and _login["p"].poll() is None:          # waiting for the click in the browser
            return dict(out, ok=False, login=True, url=url, error="not logged in",
                        hint="已经打开浏览器登录 Claude：在浏览器里点「授权」，她就连上了。")
        if claude_logged_in(bin_) is False:                                    # the login ended without one
            tail = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07", "", _login.get("out") or "").strip().splitlines()[-1:]
            return dict(out, ok=False, error=(tail[0] if tail else "login failed")[:200],
                        hint="Claude Code 没有登录成功：再点一次「连接」，在浏览器里点「授权」。")
    t0 = time.time()
    try:
        txt = "".join(stream(name, [{"role": "system", "content": "你是她。只回一个字：好"}, {"role": "user", "content": "在吗"}],
                             model, first_timeout=45)).strip()
        if not txt: return dict(out, ok=False, error="empty reply", hint=f"{LABEL[name]} 没有回答：再点一次连接试试。")
        return dict(out, ok=True, ms=int((time.time() - t0) * 1000), reply=txt[:40])
    except AgentError as e:
        return dict(out, ok=False, error=str(e)[:300], hint=e.hint or hint(name, e))
