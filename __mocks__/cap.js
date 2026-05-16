/**
 * Manual mock for 'cap' (Npcap) — used when cap is not installed.
 * Vitest picks this up automatically when vi.mock('cap') is called.
 */

const mockCapInstance = {
  open: jest.fn
    ? jest.fn()
    : (() => {
        const f = () => {};
        f.mock = { calls: [] };
        return f;
      })(),
  close: jest.fn
    ? jest.fn()
    : (() => {
        const f = () => {};
        f.mock = { calls: [] };
        return f;
      })(),
  on: jest.fn
    ? jest.fn()
    : (() => {
        const f = () => {};
        f.mock = { calls: [] };
        return f;
      })(),
};

function Cap() {
  return mockCapInstance;
}
Cap.findDevice = () => "eth0";

module.exports = {
  Cap,
  decoders: {
    Ethernet: () => ({ info: { type: 2048 }, offset: 14 }),
    IPV4: () => ({ info: { srcaddr: "192.168.1.1", dstaddr: "8.8.8.8", protocol: 6 }, offset: 34 }),
    PROTOCOL: { ETHERNET: { IPV4: 2048 } },
  },
};
