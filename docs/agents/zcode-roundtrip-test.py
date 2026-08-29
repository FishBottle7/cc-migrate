# -*- coding: utf-8 -*-
"""ZCode forged-session round-trip test.

1. Snapshot live db.sqlite (read-only backup API) into sandbox ZCODE_HOME.
2. Forge a parent session (+ Agent tool part) and a subagent_child session
   directly with SQL, mimicking engine ID conventions.
3. Run `zcode.cjs app-server --stdio` against the sandbox and drive the
   NDJSON protocol: session/list, session/messages, session/subagents.
"""
import json, os, shutil, sqlite3, subprocess, sys, threading, time, uuid, queue

ENGINE = r"D:\Users\FishBottle\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs"
LIVE_DB = os.path.expanduser(r"~\.zcode\cli\db\db.sqlite")
HOME = os.environ.get("TEMP", r"C:\Users\FishBottle\AppData\Local\Temp")
SANDBOX = os.path.join(HOME, "zcode-rt")
DB = os.path.join(SANDBOX, "cli", "db", "db.sqlite")

def b36(n):
    s = ""
    while n:
        s = "0123456789abcdefghijklmnopqrstuvwxyz"[n % 36] + s
        n //= 36
    return s or "0"

now_ms = int(time.time() * 1000)
ts = b36(now_ms)
U1, U2 = uuid.uuid4(), uuid.uuid4()
PARENT = f"sess_{U1}"
CHILD = f"sess_subagent_agent_{U2}"
M1 = f"msg_{ts}_{uuid.uuid4()}"
M2 = f"msg_{ts}_{uuid.uuid4()}"
CM1 = f"msg_part_{ts}_{uuid.uuid4()}_message"
CM2 = f"msg_part_{ts}_{uuid.uuid4()}_message"
CALL = "call_" + uuid.uuid4().hex[:24]
DIR = r"D:\codes\dshPlugins\cc-migrate"

# ---------- 1. sandbox ----------
if os.path.exists(SANDBOX):
    shutil.rmtree(SANDBOX, ignore_errors=True)
os.makedirs(os.path.dirname(DB))
src = sqlite3.connect(f"file:{LIVE_DB.replace(os.sep, '/')}?mode=ro", uri=True)
dst = sqlite3.connect(DB)
src.backup(dst)
dst.commit(); dst.close(); src.close()
print("[1] sandbox db ready:", DB)

# ---------- 2. forge ----------
con = sqlite3.connect(DB)
cur = con.cursor()
VIS = {"uiVisibility": "visible", "providerVisibility": "visible", "transcriptVisibility": "visible"}
cur.execute(
    "insert into session (id, project_id, slug, directory, path, title, version, permission,"
    " time_created, time_updated, task_type, title_source) values (?,?,?,?,?,?,?,?,?,?,?,?)",
    (PARENT, "proj_d-codes-dshplugins-cc-migrate", PARENT, DIR, DIR,
     "round-trip forged session", "0.16.3", '{"mode":"build"}', now_ms, now_ms,
     "interactive", "first_input"))
cur.execute(
    "insert into message (id, session_id, time_created, time_updated, data, sequence)"
    " values (?,?,?,?,?,0)",
    (M1, PARENT, now_ms, now_ms, json.dumps({
        "role": "user", "time": {"created": now_ms}, "agent": "zcode-agent",
        "model": {"providerID": "1953e4f2-58f2-4d0d-8f56-8e3c8ce9ce1d", "modelID": "glm-5.3-flash"},
        "semantics": {"origin": "real_user", "kind": "user_prompt", **VIS},
        "anchor": {"turnId": f"turn_{U1}", "origin": "realUser"},
    })))
cur.execute(
    "insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)"
    " values (?,?,?,?,?,?,0)",
    (f"part_{ts}_{uuid.uuid4()}", M1, PARENT, now_ms, now_ms, json.dumps({
        "type": "text", "text": "forged round-trip probe text ZCODE_RT_12345",
        "time": {"start": now_ms, "end": now_ms}})))
cur.execute(
    "insert into message (id, session_id, time_created, time_updated, data, sequence)"
    " values (?,?,?,?,?,1)",
    (M2, PARENT, now_ms + 1, now_ms + 1, json.dumps({
        "role": "assistant", "time": {"created": now_ms + 1, "completed": now_ms + 2},
        "parentID": M1, "modelID": "glm-5.3-flash",
        "providerID": "1953e4f2-58f2-4d0d-8f56-8e3c8ce9ce1d", "mode": "build",
        "agent": "zcode-agent", "path": {"cwd": DIR, "root": DIR}, "cost": 0,
        "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}},
        "finish": "stop",
        "semantics": {"origin": "agent_runtime", "kind": "assistant_response", **VIS},
    })))
cur.execute(
    "insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)"
    " values (?,?,?,?,?,?,0)",
    (f"part_{ts}_{uuid.uuid4()}", M2, PARENT, now_ms + 1, now_ms + 1, json.dumps({
        "type": "tool", "callID": CALL, "tool": "Agent",
        "state": {"status": "completed",
                  "input": {"description": "rt probe", "prompt": "probe prompt"},
                  "output": "probe report", "title": "Agent",
                  "metadata": {"schemaVersion": 1, "agentId": f"agent_{U2}",
                               "serialization": {"truncated": False,
                              "originalBytes": 12, "returnedBytes": 12, "budgetStrategy": "inline"}},
                  "time": {"start": now_ms + 1, "end": now_ms + 2}}})))
cur.execute(
    "insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)"
    " values (?,?,?,?,?,?,1)",
    (f"part_{ts}_{uuid.uuid4()}", M2, PARENT, now_ms + 2, now_ms + 2, json.dumps({
        "type": "text", "text": "done", "time": {"start": now_ms + 2, "end": now_ms + 2}})))
# child subagent session
cur.execute(
    "insert into session (id, parent_id, project_id, slug, directory, path, title, version,"
    " permission, time_created, time_updated, task_type, title_source)"
    " values (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    (CHILD, PARENT, "proj_d-codes-dshplugins-cc-migrate", CHILD, DIR, DIR,
     "probe subagent child", "0.16.3", '{"mode":"build"}', now_ms, now_ms,
     "subagent_child", "first_input"))
cur.execute(
    "insert into message (id, session_id, time_created, time_updated, data, sequence)"
    " values (?,?,?,?,?,0)",
    (CM1, CHILD, now_ms, now_ms, json.dumps({
        "role": "assistant", "time": {"created": now_ms, "completed": now_ms + 1},
        "parentID": CM1, "modelID": "GLM-5.3-1M",
        "providerID": "685c0ff0-78b6-4b58-b80c-934814d8f396", "mode": "yolo",
        "agent": "zcode-Explore", "path": {"cwd": DIR, "root": DIR}, "cost": 0,
        "tokens": {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}},
        "finish": "completed",
        "semantics": {"origin": "system", "kind": "timeline_event", **VIS},
    })))
cur.execute(
    "insert into message (id, session_id, time_created, time_updated, data, sequence)"
    " values (?,?,?,?,?,1)",
    (CM2, CHILD, now_ms + 1, now_ms + 1, json.dumps({
        "role": "user", "time": {"created": now_ms + 1}, "agent": "zcode-Explore",
        "semantics": {"origin": "agent_runtime", "kind": "user_prompt", **VIS},
    })))
con.commit()
n_msg = cur.execute("select count(*) from message where session_id in (?,?)",
                    (PARENT, CHILD)).fetchone()[0]
con.close()
print(f"[2] forged: parent={PARENT} child={CHILD} msgs={n_msg}")

# ---------- 3. drive engine protocol ----------
env = dict(os.environ)
env["ZCODE_HOME"] = SANDBOX
env["ZCODE_SESSION_DB_PATH"] = DB
env.pop("ZCODE_APP_VERSION", None)
proc = subprocess.Popen(
    ["node", ENGINE, "app-server", "--stdio"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    env=env, cwd=DIR, text=True, encoding="utf-8", errors="replace")
lines = queue.Queue()
def reader():
    for line in proc.stdout:
        lines.put(line.rstrip("\n"))
threading.Thread(target=reader, daemon=True).start()

def rpc(rid, method, params=None, timeout=45):
    msg = {"id": rid, "method": method}
    if params is not None:
        msg["params"] = params
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            line = lines.get(timeout=deadline - time.time())
        except queue.Empty:
            return None
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except Exception:
            print("   (noise)", line[:150])
            continue
        if obj.get("id") == rid and ("result" in obj or "error" in obj) and "method" not in obj:
            return obj
        if "method" in obj and "id" in obj:
            # server→client 请求：应答运行时偏好默认值
            reply = {"id": obj["id"], "result": {
                "nativeSearchEnhancementsEnabled": True, "memoryEnabled": False,
                "askUserQuestionAutoResolutionEnabled": True,
                "modelContextBudgetStrategy": "preflight-v1"}}
            proc.stdin.write(json.dumps(reply) + "\n")
            proc.stdin.flush()
            print("   (answered server request:", obj["method"], ")")
    return None

try:
    r1 = rpc("1", "session/list", {"limit": 200}, timeout=60)
    if r1 is None:
        print("[3] session/list: 无响应（可能启动失败）")
    else:
        if "result" in r1:
            sess = r1["result"].get("sessions", [])
            ids = [s.get("sessionId") or "?" for s in sess]
            print(f"[3] session/list OK: {len(sess)} 个会话")
            print("    伪造会话在列表中:", PARENT in ids, "| 子会话在列表中:", CHILD in ids)
            for s in sess:
                if s.get("sessionId") == PARENT:
                    print("    伪造会话投影:", json.dumps({k: s[k] for k in
                          ("sessionId", "sessionKind", "title", "titleSource", "mode", "status", "createdAt", "workspace")
                          if k in s}, ensure_ascii=False)[:400])
        else:
            print("[3] session/list ERROR:", json.dumps(r1)[:400])
    r0 = rpc("0", "session/resume", {"sessionId": PARENT}, timeout=45)
    print("[3b] session/resume:", ("OK " + json.dumps(r0.get("result", {}), ensure_ascii=False)[:200]) if r0 and "result" in r0 else json.dumps(r0)[:300] if r0 else "无响应")
    r2 = rpc("2", "session/messages", {"sessionId": PARENT}, timeout=45)
    if r2 and "result" in r2:
        msgs = r2["result"].get("messages", [])
        print(f"[4] session/messages OK: {len(msgs)} 条")
        for m in msgs:
            info = m.get("info", {})
            kinds = [p.get("type") for p in m.get("parts", [])]
            print(f"    {info.get('role')} seq-part-types={kinds}")
            for p in m.get("parts", []):
                if p.get("type") == "text" and "ZCODE_RT_12345" in (p.get("text") or ""):
                    print("    >>> 探针文本命中")
            tool_parts = [p for p in m.get("parts", []) if p.get("type") == "tool"]
            for tp in tool_parts:
                st = tp.get("state", {})
                print(f"    tool part: callId={tp.get('callID')} tool={tp.get('tool')} status={st.get('status')}")
    else:
        print("[4] session/messages:", json.dumps(r2)[:400] if r2 else "无响应")
    r3 = rpc("3", "session/subagents", {"sessionId": PARENT}, timeout=45)
    if r3 and "result" in r3:
        res = r3["result"]
        print("[5] session/subagents OK:", json.dumps(res, ensure_ascii=False)[:600])
    else:
        print("[5] session/subagents:", json.dumps(r3)[:400] if r3 else "无响应")
finally:
    try:
        proc.stdin.close()
    except Exception:
        pass
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
    err = proc.stderr.read() if proc.stderr else ""
    tail = [l for l in err.splitlines() if l.strip()][-8:]
    print("[stderr tail]")
    for l in tail:
        print("   ", l[:200])
print("done")
