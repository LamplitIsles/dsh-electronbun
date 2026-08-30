const std = @import("std");

fn requiresQuotes(arg: []const u8) bool {
    if (arg.len == 0) return true;
    for (arg) |byte| {
        if (byte == ' ' or byte == '\t' or byte == '"') return true;
    }
    return false;
}

/// Quote one UTF-8 argument using the CommandLineToArgvW backslash/quote
/// grammar. The caller owns the returned allocation.
pub fn quoteWindowsArg(allocator: std.mem.Allocator, arg: []const u8) ![]u8 {
    if (!requiresQuotes(arg)) return allocator.dupe(u8, arg);

    var size: usize = 2; // opening and closing quote
    var backslashes: usize = 0;
    for (arg) |byte| {
        if (byte == '\\') {
            backslashes += 1;
            continue;
        }
        if (byte == '"') {
            size += backslashes * 2 + 2;
        } else {
            size += backslashes + 1;
        }
        backslashes = 0;
    }
    size += backslashes * 2;

    const result = try allocator.alloc(u8, size);
    var index: usize = 0;
    result[index] = '"';
    index += 1;
    backslashes = 0;
    for (arg) |byte| {
        if (byte == '\\') {
            backslashes += 1;
            continue;
        }
        if (byte == '"') {
            var count = backslashes * 2 + 1;
            while (count > 0) : (count -= 1) {
                result[index] = '\\';
                index += 1;
            }
            result[index] = '"';
            index += 1;
        } else {
            while (backslashes > 0) : (backslashes -= 1) {
                result[index] = '\\';
                index += 1;
            }
            result[index] = byte;
            index += 1;
        }
        backslashes = 0;
    }
    while (backslashes > 0) : (backslashes -= 1) {
        result[index] = '\\';
        index += 1;
    }
    // Backslashes immediately before the closing quote must be doubled.
    // The loop above emitted the original run; append the second run by
    // reconstructing only that suffix would be error-prone, so the sizing and
    // writer below handles trailing slashes in a dedicated pass.
    if (arg.len > 0) {
        var trailing: usize = 0;
        var i = arg.len;
        while (i > 0 and arg[i - 1] == '\\') : (i -= 1) trailing += 1;
        if (trailing > 0) {
            // The original trailing run was emitted above. Insert the extra
            // run before the closing quote by shifting the quote one byte at a
            // time; this keeps the implementation allocator-only and UTF-8
            // agnostic.
            var shift = trailing;
            while (shift > 0) : (shift -= 1) {
                result[index] = '\\';
                index += 1;
            }
        }
    }
    result[index] = '"';
    return result;
}

test "quotes spaces and embedded quotes" {
    const allocator = std.testing.allocator;
    const quoted = try quoteWindowsArg(allocator, "C:\\Program Files\\Bun\\bun.exe");
    defer allocator.free(quoted);
    try std.testing.expectEqualStrings("\"C:\\Program Files\\Bun\\bun.exe\"", quoted);

    const embedded = try quoteWindowsArg(allocator, "a\"b c");
    defer allocator.free(embedded);
    try std.testing.expectEqualStrings("\"a\\\"b c\"", embedded);
}

test "empty and plain arguments" {
    const allocator = std.testing.allocator;
    const empty = try quoteWindowsArg(allocator, "");
    defer allocator.free(empty);
    try std.testing.expectEqualStrings("\"\"", empty);

    const plain = try quoteWindowsArg(allocator, "--health");
    defer allocator.free(plain);
    try std.testing.expectEqualStrings("--health", plain);
}

test "doubles trailing slashes and escapes quotes" {
    const allocator = std.testing.allocator;
    const trailing = try quoteWindowsArg(allocator, "a b\\");
    defer allocator.free(trailing);
    try std.testing.expectEqualStrings("\"a b\\\\\"", trailing);

    const quote = try quoteWindowsArg(allocator, "a\"b");
    defer allocator.free(quote);
    try std.testing.expectEqualStrings("\"a\\\"b\"", quote);
}
