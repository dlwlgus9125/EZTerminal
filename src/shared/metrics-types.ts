/**
 * Shared metrics type definitions.
 * Used by system monitor (main → renderer).
 */

export interface CpuData {
  /** Overall CPU usage percentage 0-100 */
  usage: number;
  /** Per-core usage percentages */
  cores: number[];
}

export interface MemoryData {
  /** Total RAM in bytes */
  total: number;
  /** Used RAM in bytes */
  used: number;
  /** Free RAM in bytes */
  free: number;
}

export interface DiskData {
  /** Disk read bytes/sec */
  readBytesPerSec: number;
  /** Disk write bytes/sec */
  writeBytesPerSec: number;
}

export interface MetricsData {
  cpu: CpuData;
  memory: MemoryData;
  disk: DiskData;
  /** Unix timestamp ms */
  timestamp: number;
}
