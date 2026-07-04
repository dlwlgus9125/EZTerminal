import { describe, expect, it } from 'vitest';

import { isAppUrl } from './url-guard';

const DEV = 'http://localhost:5173';
const APP = 'file:///C:/app/.vite/renderer/main_window/index.html';

describe('isAppUrl — navigation guard (SEC-HIGH-2, B-M6 hardened)', () => {
  it('allows exactly the packaged renderer index.html', () => {
    expect(isAppUrl(APP, undefined, APP)).toBe(true);
  });

  it('allows the renderer URL with query/hash suffixes', () => {
    expect(isAppUrl(`${APP}?x=1`, undefined, APP)).toBe(true);
    expect(isAppUrl(`${APP}#top`, undefined, APP)).toBe(true);
  });

  it('allows a case-twiddled renderer URL (Windows paths are case-insensitive)', () => {
    expect(isAppUrl(APP.toUpperCase(), undefined, APP)).toBe(true);
  });

  it('BLOCKS arbitrary file:// URLs (the B-M6 hardening)', () => {
    expect(isAppUrl('file:///C:/evil/payload.html', undefined, APP)).toBe(false);
    expect(isAppUrl('file:///C:/app/.vite/renderer/main_window/other.html', undefined, APP)).toBe(
      false,
    );
    // Prefix look-alike that is NOT followed by ? or #.
    expect(isAppUrl(`${APP}.evil.html`, undefined, APP)).toBe(false);
  });

  it('BLOCKS every file:// URL when no renderer URL is configured', () => {
    expect(isAppUrl(APP, DEV, undefined)).toBe(false);
  });

  it('allows the Vite dev-server URL when set', () => {
    expect(isAppUrl(`${DEV}/index.html`, DEV, undefined)).toBe(true);
    expect(isAppUrl(DEV, DEV, undefined)).toBe(true);
  });

  it('BLOCKS a remote http(s) origin (the OSC-8 link attack)', () => {
    expect(isAppUrl('https://evil.example.com/', DEV, APP)).toBe(false);
    expect(isAppUrl('http://evil.example.com/', undefined, APP)).toBe(false);
  });

  it('BLOCKS the dev URL when it is not configured (packaged build)', () => {
    expect(isAppUrl(`${DEV}/index.html`, undefined, APP)).toBe(false);
  });

  it('BLOCKS other schemes and empty input', () => {
    expect(isAppUrl('javascript:alert(1)', DEV, APP)).toBe(false);
    expect(isAppUrl('data:text/html,<script>', DEV, APP)).toBe(false);
    expect(isAppUrl('', DEV, APP)).toBe(false);
  });

  it('does not allow a look-alike origin that merely starts similarly', () => {
    expect(isAppUrl('http://localhost.evil.com/', DEV, APP)).toBe(false);
  });
});
