const std = @import("std");
const command_line = @import("command_line.zig");

const windows = std.os.windows;

// Job Object APIs are not wrapped by std.os.windows. Declare only the
// functions and ABI-compatible records this small executable needs; this
// keeps cross-compilation independent of an installed C header/libc tree.
extern "kernel32" fn OpenProcess(
    desired_access: windows.DWORD,
    inherit_handle: windows.BOOL,
    process_id: windows.DWORD,
) callconv(.winapi) ?windows.HANDLE;
extern "kernel32" fn CreateJobObjectW(
    attributes: ?*windows.SECURITY_ATTRIBUTES,
    name: ?windows.LPCWSTR,
) callconv(.winapi) ?windows.HANDLE;
extern "kernel32" fn SetInformationJobObject(
    job: windows.HANDLE,
    info_class: u32,
    info: *anyopaque,
    info_length: windows.DWORD,
) callconv(.winapi) windows.BOOL;
extern "kernel32" fn AssignProcessToJobObject(job: windows.HANDLE, process: windows.HANDLE) callconv(.winapi) windows.BOOL;
extern "kernel32" fn TerminateJobObject(job: windows.HANDLE, exit_code: windows.UINT) callconv(.winapi) windows.BOOL;
extern "kernel32" fn ResumeThread(thread: windows.HANDLE) callconv(.winapi) windows.DWORD;
extern "kernel32" fn CloseHandle(handle: windows.HANDLE) callconv(.winapi) windows.BOOL;
extern "kernel32" fn TerminateProcess(process: windows.HANDLE, exit_code: windows.UINT) callconv(.winapi) windows.BOOL;
extern "kernel32" fn GetExitCodeProcess(process: windows.HANDLE, exit_code: *windows.DWORD) callconv(.winapi) windows.BOOL;
extern "kernel32" fn WaitForSingleObject(handle: windows.HANDLE, milliseconds: windows.DWORD) callconv(.winapi) windows.DWORD;
extern "kernel32" fn WaitForMultipleObjects(
    count: windows.DWORD,
    handles: [*]const windows.HANDLE,
    wait_all: windows.BOOL,
    milliseconds: windows.DWORD,
) callconv(.winapi) windows.DWORD;
extern "kernel32" fn ExitProcess(exit_code: windows.UINT) callconv(.winapi) noreturn;
extern "kernel32" fn CreateProcessW(
    application_name: ?windows.LPCWSTR,
    command_line: ?windows.LPWSTR,
    process_attributes: ?*windows.SECURITY_ATTRIBUTES,
    thread_attributes: ?*windows.SECURITY_ATTRIBUTES,
    inherit_handles: windows.BOOL,
    creation_flags: windows.DWORD,
    environment: ?windows.LPVOID,
    current_directory: ?windows.LPCWSTR,
    startup_info: *windows.STARTUPINFOW,
    process_information: *windows.PROCESS.INFORMATION,
) callconv(.winapi) windows.BOOL;

const JobBasicLimitInformation = extern struct {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: windows.DWORD,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: windows.DWORD,
    affinity: usize,
    priority_class: windows.DWORD,
    scheduling_class: windows.DWORD,
};

const IoCounters = extern struct {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
};

const JobExtendedLimitInformation = extern struct {
    basic_limit_information: JobBasicLimitInformation,
    io_info: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_job_memory_used: usize,
};

const process_synchronize: windows.DWORD = 0x00100000;
const create_suspended: windows.DWORD = 0x00000004;
const create_unicode_environment: windows.DWORD = 0x00000400;
const job_object_extended_limit_information: u32 = 9;
const job_object_limit_kill_on_job_close: windows.DWORD = 0x00002000;
const wait_object_0: windows.DWORD = 0;
const wait_failed: windows.DWORD = 0xFFFFFFFF;
const infinite: windows.DWORD = 0xFFFFFFFF;
const still_active: windows.DWORD = 259;

const ChildSpec = struct {
    parent_pid: windows.DWORD,
    bun_path: []const u8,
    entrypoint: []const u8,
    args: []const []const u8,
};

fn win32Failure(operation: []const u8) error{Win32OperationFailed} {
    const code = windows.GetLastError();
    std.log.err("{s} failed (Win32 error {d})", .{ operation, @intFromEnum(code) });
    return error.Win32OperationFailed;
}

fn closeHandle(handle: ?windows.HANDLE) void {
    if (handle) |value| _ = CloseHandle(value);
}

fn isAbsoluteWindowsPath(path: []const u8) bool {
    return (path.len >= 3 and std.ascii.isAlphabetic(path[0]) and path[1] == ':' and
        (path[2] == '\\' or path[2] == '/')) or (path.len >= 2 and path[0] == '\\' and path[1] == '\\');
}

fn makeCommandLine(allocator: std.mem.Allocator, spec: ChildSpec) ![]u8 {
    var values = std.array_list.Managed([]const u8).init(allocator);
    defer values.deinit();
    try values.append(spec.bun_path);
    try values.append(spec.entrypoint);
    try values.appendSlice(spec.args);

    var output = std.array_list.Managed(u8).init(allocator);
    errdefer output.deinit();
    for (values.items, 0..) |value, index| {
        if (index != 0) try output.append(' ');
        const quoted = try command_line.quoteWindowsArg(allocator, value);
        defer allocator.free(quoted);
        try output.appendSlice(quoted);
    }
    try output.append(0);
    return output.toOwnedSlice();
}

fn wideZ(allocator: std.mem.Allocator, value: []const u8) ![:0]u16 {
    return std.unicode.utf8ToUtf16LeAllocZ(allocator, value);
}

fn parsePid(text: []const u8) !windows.DWORD {
    const value = std.fmt.parseUnsigned(u32, text, 10) catch return error.InvalidArguments;
    if (value == 0) return error.InvalidArguments;
    return value;
}

fn parseArgs(allocator: std.mem.Allocator, argv: []const []const u8) !ChildSpec {
    var parent_pid: ?windows.DWORD = null;
    var bun_path: ?[]const u8 = null;
    var entrypoint: ?[]const u8 = null;
    var child_args = std.array_list.Managed([]const u8).init(allocator);
    errdefer child_args.deinit();

    var index: usize = 1;
    while (index < argv.len) {
        const value = argv[index];
        if (std.mem.eql(u8, value, "--")) {
            index += 1;
            while (index < argv.len) : (index += 1) try child_args.append(argv[index]);
            break;
        }
        if (std.mem.eql(u8, value, "--parent-pid") and index + 1 < argv.len) {
            parent_pid = try parsePid(argv[index + 1]);
            index += 2;
            continue;
        }
        if (std.mem.eql(u8, value, "--bun") and index + 1 < argv.len) {
            bun_path = argv[index + 1];
            index += 2;
            continue;
        }
        if (std.mem.eql(u8, value, "--entrypoint") and index + 1 < argv.len) {
            entrypoint = argv[index + 1];
            index += 2;
            continue;
        }
        return error.InvalidArguments;
    }
    const bun = bun_path orelse return error.InvalidArguments;
    const entry = entrypoint orelse return error.InvalidArguments;
    if (!isAbsoluteWindowsPath(bun) or !isAbsoluteWindowsPath(entry)) return error.InvalidArguments;
    return .{ .parent_pid = parent_pid orelse return error.InvalidArguments, .bun_path = bun, .entrypoint = entry, .args = try child_args.toOwnedSlice() };
}

fn terminateJob(job: windows.HANDLE, process: windows.HANDLE) void {
    _ = TerminateJobObject(job, 1);
    _ = TerminateProcess(process, 1);
}

fn getExitCode(process: windows.HANDLE) !u32 {
    var code: windows.DWORD = still_active;
    if (GetExitCodeProcess(process, &code) == .FALSE) return win32Failure("GetExitCodeProcess");
    return code;
}

pub fn run(allocator: std.mem.Allocator, argv: []const []const u8) !void {
    const spec = parseArgs(allocator, argv) catch |err| {
        std.log.err("invalid supervisor arguments; expected --parent-pid PID --bun ABSOLUTE --entrypoint ABSOLUTE -- ARGS...", .{});
        return err;
    };
    defer allocator.free(spec.args);

    const parent = OpenProcess(process_synchronize, windows.BOOL.FALSE, spec.parent_pid) orelse return win32Failure("OpenProcess");
    defer closeHandle(parent);
    const job = CreateJobObjectW(null, null) orelse return win32Failure("CreateJobObjectW");
    defer closeHandle(job);

    var limits: JobExtendedLimitInformation = std.mem.zeroes(JobExtendedLimitInformation);
    limits.basic_limit_information.limit_flags = job_object_limit_kill_on_job_close;
    if (SetInformationJobObject(job, job_object_extended_limit_information, &limits, @sizeOf(JobExtendedLimitInformation)) == .FALSE) {
        return win32Failure("SetInformationJobObject");
    }

    const command_line_bytes = try makeCommandLine(allocator, spec);
    defer allocator.free(command_line_bytes);
    const bun_wide = try wideZ(allocator, spec.bun_path);
    defer allocator.free(bun_wide);
    const command_wide = try std.unicode.utf8ToUtf16LeAllocZ(allocator, command_line_bytes[0 .. command_line_bytes.len - 1]);
    defer allocator.free(command_wide);

    var startup: windows.STARTUPINFOW = std.mem.zeroes(windows.STARTUPINFOW);
    startup.cb = @sizeOf(windows.STARTUPINFOW);
    var information: windows.PROCESS.INFORMATION = std.mem.zeroes(windows.PROCESS.INFORMATION);
    const flags: windows.DWORD = create_suspended | create_unicode_environment;
    if (CreateProcessW(bun_wide.ptr, @constCast(command_wide.ptr), null, null, windows.BOOL.FALSE, flags, null, null, &startup, &information) == .FALSE) {
        return win32Failure("CreateProcessW");
    }
    defer closeHandle(information.hThread);
    defer closeHandle(information.hProcess);

    // Assignment happens while the child is still suspended. Any failure is
    // fail-closed: terminate the child and never resume or report success.
    if (AssignProcessToJobObject(job, information.hProcess) == .FALSE) {
        const result = win32Failure("AssignProcessToJobObject");
        terminateJob(job, information.hProcess);
        return result;
    }
    if (ResumeThread(information.hThread) == std.math.maxInt(windows.DWORD)) {
        const result = win32Failure("ResumeThread");
        terminateJob(job, information.hProcess);
        return result;
    }

    var handles = [_]windows.HANDLE{ parent, information.hProcess };
    const wait_result = WaitForMultipleObjects(@intCast(handles.len), &handles, windows.BOOL.FALSE, infinite);
    if (wait_result == wait_failed) {
        const result = win32Failure("WaitForMultipleObjects");
        terminateJob(job, information.hProcess);
        return result;
    }
    if (wait_result == wait_object_0) {
        // The desktop disappeared. Closing/terminating the job owns every
        // descendant; wait for Bun's process handle before returning.
        terminateJob(job, information.hProcess);
        _ = WaitForSingleObject(information.hProcess, infinite);
    }
    const exit_code = try getExitCode(information.hProcess);
    // Even a naturally exiting Bun may have spawned a descendant. Explicitly
    // terminate the job before closing it so cleanup is deterministic.
    _ = TerminateJobObject(job, exit_code);
    ExitProcess(exit_code);
}

test "invalid launch arguments fail before any process or job handle is opened" {
    const allocator = std.testing.allocator;
    const argv = [_][]const u8{
        "dsh-sidecar-supervisor",
        "--parent-pid",
        "7",
        "--bun",
        "bun.exe",
        "--entrypoint",
        "C:\\app\\sidecar.ts",
        "--",
    };
    try std.testing.expectError(error.InvalidArguments, parseArgs(allocator, &argv));
}

test "launch paths must be absolute Windows paths" {
    try std.testing.expect(!isAbsoluteWindowsPath("bun.exe"));
    try std.testing.expect(isAbsoluteWindowsPath("C:\\Program Files\\Bun\\bun.exe"));
    try std.testing.expect(isAbsoluteWindowsPath("\\\\server\\share\\bun.exe"));
}
