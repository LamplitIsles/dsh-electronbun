const std = @import("std");
const builtin = @import("builtin");

const windows_impl = if (builtin.os.tag == .windows)
    @import("windows_impl.zig")
else
    struct {
        pub fn run(_: std.mem.Allocator, _: []const []const u8) !void {
            std.log.err("dsh-sidecar-supervisor supports Windows 11 x64 only (received {s}/{s})", .{ @tagName(builtin.os.tag), @tagName(builtin.cpu.arch) });
            return error.UnsupportedPlatform;
        }
    };

pub fn main(init: std.process.Init) !void {
    if (builtin.os.tag != .windows or builtin.cpu.arch != .x86_64) {
        std.log.err("dsh-sidecar-supervisor supports Windows 11 x64 only", .{});
        return error.UnsupportedPlatform;
    }
    const allocator = init.arena.allocator();
    const argv = try init.minimal.args.toSlice(allocator);
    try windows_impl.run(allocator, argv);
}
