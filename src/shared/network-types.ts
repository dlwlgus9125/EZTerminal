/**
 * Shared network type definitions.
 * Used by network monitor (main → renderer).
 */

export interface TrafficData {
  /** Bytes received per second */
  rxBytesPerSec: number;
  /** Bytes transmitted per second */
  txBytesPerSec: number;
  /** Network interface name */
  interface: string;
  /** Unix timestamp ms */
  timestamp: number;
}

export interface ConnectionInfo {
  /** Local address */
  localAddress: string;
  /** Local port */
  localPort: number;
  /** Remote address */
  remoteAddress: string;
  /** Remote port */
  remotePort: number;
  /** Protocol: "tcp" | "udp" */
  protocol: "tcp" | "udp";
  /** Connection state e.g. "ESTABLISHED" */
  state: string;
  /** Process ID owning this connection */
  pid: number;
}

export interface PacketData {
  /** Source address */
  src: string;
  /** Destination address */
  dst: string;
  /** Protocol */
  protocol: string;
  /** Packet length in bytes */
  length: number;
  /** Unix timestamp ms */
  timestamp: number;
}
