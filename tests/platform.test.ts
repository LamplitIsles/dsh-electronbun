import { expect, test } from "bun:test";

import {
  assertSupportedWindows11X64,
  readHostPlatform,
  UnsupportedPlatformError,
} from "../src/host/platform";

test("reads the OS release and derives the Windows build through an injected seam", () => {
  expect(
    readHostPlatform({ platform: "win32", arch: "x64", release: () => "10.0.22621" }),
  ).toEqual({ platform: "win32", arch: "x64", release: "10.0.22621", build: 22621 });
});

test("fails closed with an actionable diagnostic for Windows 10 x64", () => {
  expect(() =>
    assertSupportedWindows11X64({
      platform: "win32",
      arch: "x64",
      release: "10.0.19045",
      build: 19045,
    }),
  ).toThrow(/Windows 11 x64.*release=10\.0\.19045.*build=19045.*Windows 10 x64.*unsupported/i);
});

test("accepts a Windows 11 x64 build at the minimum supported build", () => {
  expect(() =>
    assertSupportedWindows11X64({
      platform: "win32",
      arch: "x64",
      release: "10.0.22000",
      build: 22000,
    }),
  ).not.toThrow();
});

test("fails closed when the host is not Windows x64 or its build is unknown", () => {
  expect(() =>
    assertSupportedWindows11X64({ platform: "linux", arch: "x64", release: "6.8.0", build: undefined }),
  ).toThrow(UnsupportedPlatformError);
  expect(() =>
    assertSupportedWindows11X64({ platform: "win32", arch: "x64", release: "unknown", build: undefined }),
  ).toThrow(/Windows 11 x64.*unknown/i);
});
