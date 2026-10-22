using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

class Program {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern IntPtr OpenWindowStation(string lpszWinSta, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll")]
    public static extern bool SetProcessWindowStation(IntPtr hWinSta);

    [DllImport("user32.dll")]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll")]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    static string EscapeJson(string s) {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ");
    }

    static void Main(string[] args) {
        try {
            IntPtr hwinsta = OpenWindowStation("WinSta0", false, 0x037F);
            if (hwinsta != IntPtr.Zero) SetProcessWindowStation(hwinsta);
            IntPtr hdesk = OpenDesktop("Default", 0, false, 0x01FF);
            if (hdesk != IntPtr.Zero) SetThreadDesktop(hdesk);

            IntPtr fgHwnd = GetForegroundWindow();
            uint fgPid = 0;
            string fgProcName = "";
            string fgTitle = "";
            if (fgHwnd != IntPtr.Zero) {
                GetWindowThreadProcessId(fgHwnd, out fgPid);
                if (fgPid > 0) {
                    try {
                        var proc = Process.GetProcessById((int)fgPid);
                        fgProcName = proc.ProcessName;
                    } catch {}
                    int fgLen = GetWindowTextLength(fgHwnd);
                    if (fgLen > 0) {
                        var tBuf = new StringBuilder(fgLen + 1);
                        GetWindowText(fgHwnd, tBuf, tBuf.Capacity);
                        fgTitle = tBuf.ToString().Trim();
                    }
                }
            }

            var seenPids = new HashSet<uint>();
            var sb = new StringBuilder();
            sb.Append("{\"foregroundPid\":" + fgPid + ",\"foregroundProc\":\"" + EscapeJson(fgProcName) + "\",\"foregroundTitle\":\"" + EscapeJson(fgTitle) + "\",\"windows\":[");
            bool first = true;

            EnumDesktopWindows(hdesk != IntPtr.Zero ? hdesk : IntPtr.Zero, (hWnd, lParam) => {
                if (IsWindowVisible(hWnd)) {
                    int len = GetWindowTextLength(hWnd);
                    if (len > 0) {
                        uint pid;
                        GetWindowThreadProcessId(hWnd, out pid);
                        if (pid > 0 && !seenPids.Contains(pid)) {
                            seenPids.Add(pid);
                            var titleBuf = new StringBuilder(len + 1);
                            GetWindowText(hWnd, titleBuf, titleBuf.Capacity);
                            string title = titleBuf.ToString().Trim();

                            string procName = "";
                            try {
                                var proc = Process.GetProcessById((int)pid);
                                procName = proc.ProcessName;
                            } catch {}

                            if (!string.IsNullOrEmpty(procName)) {
                                if (!first) sb.Append(",");
                                first = false;
                                sb.Append("{\"pid\":" + pid + ",\"name\":\"" + EscapeJson(procName) + "\",\"title\":\"" + EscapeJson(title) + "\",\"isForeground\":" + (pid == fgPid ? "true" : "false") + "}");
                            }
                        }
                    }
                }
                return true;
            }, IntPtr.Zero);

            sb.Append("]}");
            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine(sb.ToString());
        } catch (Exception ex) {
            Console.WriteLine("{\"error\":\"" + EscapeJson(ex.Message) + "\",\"windows\":[]}");
        }
    }
}
