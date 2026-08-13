# 系统级置顶：把标题含“元宝爱财”的窗口设为始终在最前（HWND_TOPMOST）
# 关键词用 Unicode 转义避免源文件中文编码问题：\u5143\u5b9d\u7231\u8d22 = 元宝爱财
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class TopMost {
    const int HWND_TOPMOST = -1;
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    private static bool Callback(IntPtr hWnd, IntPtr lParam) {
        if (!IsWindowVisible(hWnd)) return true;
        StringBuilder sb = new StringBuilder(256);
        GetWindowText(hWnd, sb, 256);
        if (sb.ToString().IndexOf("\u5143\u5b9d\u7231\u8d22") >= 0) {
            SetWindowPos(hWnd, (IntPtr)HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE);
        }
        return true;
    }

    public static void Pin() {
        EnumWindows(Callback, IntPtr.Zero);
    }
}
'@ -ErrorAction SilentlyContinue

# 循环 20 秒：覆盖 Chrome 启动延迟，并在窗口重建后重新置顶
for ($i = 0; $i -lt 40; $i++) {
    [TopMost]::Pin()
    Start-Sleep -Milliseconds 500
}
