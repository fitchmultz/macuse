// Experimental worker. No app control, Node, Objective-C objects, or file/network APIs enter JavaScript.
import Foundation
import JavaScriptCore
import Darwin

@_silgen_name("sandbox_init") private func sandboxInit(_ profile: UnsafePointer<CChar>, _ flags: UInt64, _ error: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int32

private let limit = 65_536
private func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), data.count <= limit else { exit(71) }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
private func receive() -> [String: Any]? {
    // Read bounded bytes, not readLine(), which can allocate an unbounded guest response.
    var data = Data()
    while true {
        var byte: UInt8 = 0
        let count = Darwin.read(STDIN_FILENO, &byte, 1)
        if count != 1 { return nil }
        if byte == 10 { break }
        if data.count >= limit { exit(72) }
        data.append(byte)
    }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

private func sandbox(_ fixture: String) -> Bool {
    var error: UnsafeMutablePointer<CChar>?
    // Foundation/JSC are already loaded. No home directory, runtime files, sockets,
    // process execution, app services, or mach service access is needed by guest code.
    let profile = "(version 1)(deny default)(allow sysctl-read)"
    guard profile.withCString({ sandboxInit($0, 0, &error) }) == 0 else { return false }
    let readFD = open(fixture, O_RDONLY)
    let readDenied = readFD == -1 && errno == EPERM
    if readFD != -1 { close(readFD) }
    let path = "\(fixture).write"
    let writeFD = open(path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
    let writeDenied = writeFD == -1 && errno == EPERM
    if writeFD != -1 { close(writeFD); unlink(path) }
    let socketFD = socket(AF_INET, SOCK_STREAM, 0)
    var networkDenied = socketFD == -1 && errno == EPERM
    if socketFD != -1 {
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(9).bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(socketFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        networkDenied = connected == -1 && errno == EPERM
        close(socketFD)
    }
    var pid: pid_t = 0
    var args: [UnsafeMutablePointer<CChar>?] = [strdup("/usr/bin/true"), nil]
    defer { free(args[0]) }
    var environment: [UnsafeMutablePointer<CChar>?] = [nil]
    let spawned = posix_spawn(&pid, "/usr/bin/true", nil, nil, &args, &environment)
    if spawned == 0 { var status: Int32 = 0; waitpid(pid, &status, 0) }
    if !(readDenied && writeDenied && networkDenied && spawned == EPERM) {
        fputs("Sandbox deny probes: read=\(readDenied), write=\(writeDenied), network=\(networkDenied), spawn_errno=\(spawned)\n", stderr)
    }
    return readDenied && writeDenied && networkDenied && spawned == EPERM
}

// Initialize the engine before sandboxing; expose only a string-in/string-out block.
guard let context = JSContext() else { exit(73) }
guard CommandLine.arguments.count == 2, sandbox(CommandLine.arguments[1]) else { emit(["type": "fatal", "error": "OS sandbox installation/deny probes failed; refusing execution."]); exit(74) }
var runID = ""
var sequence = 0
let rpc: @convention(block) (String) -> String = { request in
    guard !runID.isEmpty, request.utf8.count <= limit,
          let bytes = request.data(using: .utf8),
          let object = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
          let method = object["method"] as? String,
          let params = object["params"] as? [String: Any] else { return "{\"error\":\"Invalid capability request.\"}" }
    sequence += 1
    emit(["type": "call", "runId": runID, "callId": sequence, "method": method, "params": params])
    guard let reply = receive(), reply["type"] as? String == "reply",
          reply["runId"] as? String == runID, reply["callId"] as? Int == sequence,
          let data = try? JSONSerialization.data(withJSONObject: reply), let json = String(data: data, encoding: .utf8) else { exit(75) }
    return json
}
context.setObject(rpc, forKeyedSubscript: "__macuseRPC" as NSString)
context.evaluateScript("""
(function(rpc) {
  const parse = JSON.parse, stringify = JSON.stringify;
  Object.defineProperty(globalThis, 'macuse', {value: Object.freeze({
    call(method, params = {}) {
      const reply = parse(rpc(stringify({method, params})));
      if (reply.error) throw new Error(reply.error);
      return reply.value;
    }
  }), writable: false, configurable: false});
})(__macuseRPC);
delete globalThis.__macuseRPC;
""")
guard context.exception == nil else { exit(76) }
let settle = context.evaluateScript("""
(function(value, finish) {
  Promise.resolve(value).then(
    result => { try { finish(JSON.stringify({ok:true, value:result ?? null})); } catch(e) { finish(JSON.stringify({ok:false,error:String(e)})); } },
    error => finish(JSON.stringify({ok:false,error:String(error)}))
  );
})
""")!
emit(["type": "ready", "sandbox": "seatbelt-deny-default", "denied": ["file-read", "file-write", "network-connect", "process-exec"]])
while let request = receive() {
    guard request["type"] as? String == "execute", let id = request["runId"] as? String,
          let code = request["code"] as? String, !code.isEmpty else { exit(77) }
    runID = id
    sequence = 0
    context.exception = nil
    var completed: String?
    let finish: @convention(block) (String) -> Void = { value in
        if completed == nil { completed = value }
    }
    let value = context.evaluateScript(code)
    if let exception = context.exception {
        emit(["type": "result", "runId": id, "ok": false, "error": exception.toString() ?? "JavaScript failed."])
    } else {
        settle.call(withArguments: [value ?? JSValue(undefinedIn: context)!, finish])
        // Promise jobs are drained by JSC on return from its API. A permanently pending
        // promise remains pending until the parent deadline kills this owned process.
        while completed == nil { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.005)) }
        guard let bytes = completed?.data(using: .utf8), bytes.count <= limit,
              var result = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any] else { exit(78) }
        result["type"] = "result"
        result["runId"] = id
        emit(result)
    }
    runID = ""
}
