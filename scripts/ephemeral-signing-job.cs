using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace EZTerminal.Release
{
    public sealed class EphemeralSigningProcess : IDisposable
    {
        private const uint WaitObject0 = 0x00000000;
        private const uint WaitTimeout = 0x00000102;
        private const uint StillActive = 259;

        private SafeFileHandle processHandle;
        private bool disposed;

        internal EphemeralSigningProcess(
            SafeFileHandle ownedProcessHandle,
            int processId
        )
        {
            processHandle = ownedProcessHandle;
            Id = processId;
        }

        public int Id { get; private set; }

        public bool HasExited
        {
            get
            {
                EnsureActive();
                uint result = WaitForSingleObject(processHandle, 0);
                if (result == WaitObject0)
                {
                    return true;
                }
                if (result == WaitTimeout)
                {
                    return false;
                }
                throw NewWin32Exception(
                    "Could not inspect the signing process state."
                );
            }
        }

        public int ExitCode
        {
            get
            {
                EnsureActive();
                uint exitCode;
                if (!GetExitCodeProcess(processHandle, out exitCode))
                {
                    throw NewWin32Exception(
                        "Could not read the signing process exit code."
                    );
                }
                if (exitCode == StillActive)
                {
                    throw new InvalidOperationException(
                        "The signing process is still running."
                    );
                }
                return unchecked((int)exitCode);
            }
        }

        public bool WaitForExit(int milliseconds)
        {
            EnsureActive();
            if (milliseconds < 0)
            {
                throw new ArgumentOutOfRangeException("milliseconds");
            }
            uint result = WaitForSingleObject(
                processHandle,
                checked((uint)milliseconds)
            );
            if (result == WaitObject0)
            {
                return true;
            }
            if (result == WaitTimeout)
            {
                return false;
            }
            throw NewWin32Exception(
                "Could not wait for the signing process."
            );
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            if (processHandle != null)
            {
                processHandle.Dispose();
            }
        }

        private void EnsureActive()
        {
            if (
                disposed
                || processHandle == null
                || processHandle.IsClosed
                || processHandle.IsInvalid
            )
            {
                throw new ObjectDisposedException(
                    typeof(EphemeralSigningProcess).FullName
                );
            }
        }

        private static Win32Exception NewWin32Exception(string message)
        {
            return new Win32Exception(Marshal.GetLastWin32Error(), message);
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(
            SafeFileHandle handle,
            uint milliseconds
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetExitCodeProcess(
            SafeFileHandle process,
            out uint exitCode
        );
    }

    public sealed class EphemeralSigningJob : IDisposable
    {
        private const uint CreateSuspended = 0x00000004;
        private const uint CreateNoWindow = 0x08000000;
        private const uint CreateUnicodeEnvironment = 0x00000400;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private const int JobObjectBasicAccountingInformationClass = 1;
        private const int JobObjectExtendedLimitInformationClass = 9;
        private const uint SigningProcessCleanupExitCode = 0x455A0001;

        private SafeFileHandle jobHandle;
        private bool disposed;

        public EphemeralSigningJob()
        {
            if (Environment.OSVersion.Platform != PlatformID.Win32NT)
            {
                throw new PlatformNotSupportedException(
                    "Ephemeral Android signing requires a Windows Job Object."
                );
            }

            IntPtr rawJobHandle = CreateJobObject(IntPtr.Zero, null);
            if (rawJobHandle == IntPtr.Zero)
            {
                throw NewWin32Exception("Could not create the signing Job Object.");
            }

            jobHandle = new SafeFileHandle(rawJobHandle, true);
            try
            {
                var limits = new JobObjectExtendedLimitInformation();
                limits.BasicLimitInformation.LimitFlags =
                    JobObjectLimitKillOnJobClose;
                if (!SetInformationJobObject(
                    jobHandle,
                    JobObjectExtendedLimitInformationClass,
                    ref limits,
                    (uint)Marshal.SizeOf(
                        typeof(JobObjectExtendedLimitInformation)
                    )
                ))
                {
                    throw NewWin32Exception(
                        "Could not configure kill-on-close for the signing Job Object."
                    );
                }
            }
            catch
            {
                jobHandle.Dispose();
                throw;
            }
        }

        public EphemeralSigningProcess StartSuspendedAndAssign(
            ProcessStartInfo startInfo
        )
        {
            EnsureActive();
            ValidateStartInfo(startInfo);

            IntPtr environmentBlock = IntPtr.Zero;
            int environmentBlockBytes = 0;
            SafeFileHandle processHandle = null;
            SafeFileHandle threadHandle = null;
            bool assigned = false;
            bool resumed = false;
            try
            {
                environmentBlock = CreateEnvironmentBlock(
                    startInfo,
                    out environmentBlockBytes
                );
                string executable = Path.GetFullPath(startInfo.FileName);
                string workingDirectory = string.IsNullOrWhiteSpace(
                    startInfo.WorkingDirectory
                )
                    ? Environment.CurrentDirectory
                    : Path.GetFullPath(startInfo.WorkingDirectory);
                var commandLine = new StringBuilder();
                commandLine.Append('"');
                commandLine.Append(executable);
                commandLine.Append('"');
                if (!string.IsNullOrWhiteSpace(startInfo.Arguments))
                {
                    commandLine.Append(' ');
                    commandLine.Append(startInfo.Arguments);
                }

                var startup = new StartupInfo();
                startup.Size = Marshal.SizeOf(typeof(StartupInfo));
                ProcessInformation processInformation;
                uint creationFlags = CreateSuspended | CreateUnicodeEnvironment;
                if (startInfo.CreateNoWindow)
                {
                    creationFlags |= CreateNoWindow;
                }
                if (!CreateProcess(
                    executable,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    creationFlags,
                    environmentBlock,
                    workingDirectory,
                    ref startup,
                    out processInformation
                ))
                {
                    throw NewWin32Exception(
                        "Could not create the suspended signing process."
                    );
                }

                processHandle = new SafeFileHandle(
                    processInformation.ProcessHandle,
                    true
                );
                threadHandle = new SafeFileHandle(
                    processInformation.ThreadHandle,
                    true
                );
                if (!AssignProcessToJobObject(jobHandle, processHandle))
                {
                    throw NewWin32Exception(
                        "Could not assign the suspended signing process to its Job Object."
                    );
                }
                assigned = true;

                uint previousSuspendCount = ResumeThread(threadHandle);
                if (previousSuspendCount == uint.MaxValue)
                {
                    throw NewWin32Exception(
                        "Could not resume the Job-bound signing process."
                    );
                }
                if (previousSuspendCount != 1)
                {
                    throw new InvalidOperationException(
                        "The suspended signing process had an unexpected "
                        + "suspend count."
                    );
                }
                resumed = true;
                var process = new EphemeralSigningProcess(
                    processHandle,
                    checked((int)processInformation.ProcessId)
                );
                processHandle = null;
                return process;
            }
            catch
            {
                if (assigned)
                {
                    TerminateJobObject(jobHandle, SigningProcessCleanupExitCode);
                }
                else if (
                    processHandle != null
                    && !processHandle.IsInvalid
                    && !processHandle.IsClosed
                )
                {
                    TerminateProcess(
                        processHandle,
                        SigningProcessCleanupExitCode
                    );
                    WaitForSingleObject(processHandle, 30000);
                }
                throw;
            }
            finally
            {
                if (!resumed && assigned)
                {
                    TerminateJobObject(jobHandle, SigningProcessCleanupExitCode);
                }
                if (threadHandle != null)
                {
                    threadHandle.Dispose();
                }
                if (processHandle != null)
                {
                    processHandle.Dispose();
                }
                ZeroAndFreeEnvironmentBlock(
                    environmentBlock,
                    environmentBlockBytes
                );
            }
        }

        public void TerminateAndWait(int timeoutMilliseconds)
        {
            EnsureActive();
            if (timeoutMilliseconds < 1)
            {
                throw new ArgumentOutOfRangeException(
                    "timeoutMilliseconds",
                    "Signing Job Object cleanup needs a positive timeout."
                );
            }
            if (!TerminateJobObject(
                jobHandle,
                SigningProcessCleanupExitCode
            ))
            {
                throw NewWin32Exception(
                    "Could not terminate the signing Job Object."
                );
            }

            var stopwatch = Stopwatch.StartNew();
            while (true)
            {
                var accounting = new JobObjectBasicAccountingInformation();
                if (!QueryInformationJobObject(
                    jobHandle,
                    JobObjectBasicAccountingInformationClass,
                    ref accounting,
                    (uint)Marshal.SizeOf(
                        typeof(JobObjectBasicAccountingInformation)
                    ),
                    IntPtr.Zero
                ))
                {
                    throw NewWin32Exception(
                        "Could not inspect signing Job Object cleanup."
                    );
                }
                if (accounting.ActiveProcesses == 0)
                {
                    return;
                }
                if (stopwatch.ElapsedMilliseconds >= timeoutMilliseconds)
                {
                    throw new TimeoutException(
                        "Signing Job Object processes did not terminate within "
                        + timeoutMilliseconds
                        + " ms."
                    );
                }
                Thread.Sleep(20);
            }
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            if (jobHandle != null)
            {
                jobHandle.Dispose();
            }
        }

        private void EnsureActive()
        {
            if (
                disposed
                || jobHandle == null
                || jobHandle.IsClosed
                || jobHandle.IsInvalid
            )
            {
                throw new ObjectDisposedException(
                    typeof(EphemeralSigningJob).FullName
                );
            }
        }

        private static void ValidateStartInfo(ProcessStartInfo startInfo)
        {
            if (startInfo == null)
            {
                throw new ArgumentNullException("startInfo");
            }
            if (startInfo.UseShellExecute)
            {
                throw new InvalidOperationException(
                    "Ephemeral signing processes must disable shell execution."
                );
            }
            if (
                startInfo.RedirectStandardInput
                || startInfo.RedirectStandardOutput
                || startInfo.RedirectStandardError
            )
            {
                throw new InvalidOperationException(
                    "Ephemeral signing does not support redirected process handles."
                );
            }
            if (
                string.IsNullOrWhiteSpace(startInfo.FileName)
                || !Path.IsPathRooted(startInfo.FileName)
                || !File.Exists(startInfo.FileName)
            )
            {
                throw new InvalidOperationException(
                    "Ephemeral signing requires an existing absolute executable path."
                );
            }
            if (
                startInfo.FileName.IndexOf('\0') >= 0
                || (
                    startInfo.Arguments != null
                    && startInfo.Arguments.IndexOf('\0') >= 0
                )
            )
            {
                throw new InvalidOperationException(
                    "Ephemeral signing executable arguments contain a null character."
                );
            }
            if (
                !string.IsNullOrWhiteSpace(startInfo.WorkingDirectory)
                && !Directory.Exists(
                    Path.GetFullPath(startInfo.WorkingDirectory)
                )
            )
            {
                throw new InvalidOperationException(
                    "Ephemeral signing working directory does not exist."
                );
            }
        }

        private static IntPtr CreateEnvironmentBlock(
            ProcessStartInfo startInfo,
            out int byteLength
        )
        {
            var entries = new List<string>();
            foreach (
                DictionaryEntry entry
                in startInfo.EnvironmentVariables
            )
            {
                string name = entry.Key as string;
                string value = entry.Value as string;
                if (
                    string.IsNullOrEmpty(name)
                    || name.IndexOf('=') >= 0
                    || name.IndexOf('\0') >= 0
                    || value == null
                    || value.IndexOf('\0') >= 0
                )
                {
                    throw new InvalidOperationException(
                        "Ephemeral signing environment contains an invalid entry."
                    );
                }
                entries.Add(name + "=" + value);
            }
            entries.Sort(StringComparer.OrdinalIgnoreCase);
            string block = string.Join("\0", entries.ToArray()) + "\0\0";
            byteLength = checked(block.Length * sizeof(char));
            return Marshal.StringToHGlobalUni(block);
        }

        private static void ZeroAndFreeEnvironmentBlock(
            IntPtr environmentBlock,
            int byteLength
        )
        {
            if (environmentBlock == IntPtr.Zero)
            {
                return;
            }
            try
            {
                for (int index = 0; index < byteLength; index += 1)
                {
                    Marshal.WriteByte(environmentBlock, index, 0);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(environmentBlock);
            }
        }

        private static Win32Exception NewWin32Exception(string message)
        {
            return new Win32Exception(Marshal.GetLastWin32Error(), message);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobObjectBasicAccountingInformation
        {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            public int Size;
            public IntPtr Reserved;
            public IntPtr Desktop;
            public IntPtr Title;
            public int X;
            public int Y;
            public int XSize;
            public int YSize;
            public int XCountChars;
            public int YCountChars;
            public int FillAttribute;
            public int Flags;
            public short ShowWindow;
            public short ReservedSize;
            public IntPtr ReservedData;
            public IntPtr StandardInput;
            public IntPtr StandardOutput;
            public IntPtr StandardError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr ProcessHandle;
            public IntPtr ThreadHandle;
            public uint ProcessId;
            public uint ThreadId;
        }

        [DllImport(
            "kernel32.dll",
            CharSet = CharSet.Unicode,
            SetLastError = true
        )]
        private static extern IntPtr CreateJobObject(
            IntPtr jobAttributes,
            string name
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(
            SafeFileHandle handle,
            int informationClass,
            ref JobObjectExtendedLimitInformation information,
            uint informationLength
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool QueryInformationJobObject(
            SafeFileHandle handle,
            int informationClass,
            ref JobObjectBasicAccountingInformation information,
            uint informationLength,
            IntPtr returnLength
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(
            SafeFileHandle job,
            SafeFileHandle process
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(
            SafeFileHandle job,
            uint exitCode
        );

        [DllImport(
            "kernel32.dll",
            CharSet = CharSet.Unicode,
            SetLastError = true
        )]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref StartupInfo startupInfo,
            out ProcessInformation processInformation
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(SafeFileHandle thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateProcess(
            SafeFileHandle process,
            uint exitCode
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(
            SafeFileHandle handle,
            uint milliseconds
        );
    }
}
