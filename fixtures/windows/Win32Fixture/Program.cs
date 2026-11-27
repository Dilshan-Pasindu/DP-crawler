using System.Runtime.InteropServices;

namespace Win32Fixture;

internal static class Program
{
    private const int WsOverlappedWindow = 0x00CF0000;
    private const int WsVisible = 0x10000000;
    private const int WsChild = 0x40000000;
    private const int WsDisabled = 0x08000000;

    [StructLayout(LayoutKind.Sequential)]
    private struct Msg
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateWindowEx(
        int exStyle, string className, string windowName, int style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [DllImport("user32.dll")]
    private static extern bool GetMessage(out Msg lpMsg, IntPtr hWnd, uint min, uint max);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Msg lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Msg lpMsg);

    [STAThread]
    private static void Main()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var hwnd = CreateWindowEx(
            0, "STATIC", "DP Crawler Win32 Fixture",
            WsOverlappedWindow | WsVisible,
            100, 100, 400, 220, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);

        CreateWindowEx(
            0, "BUTTON", "Safe Win32 Info",
            WsChild | WsVisible,
            20, 40, 150, 32, hwnd, (IntPtr)101, IntPtr.Zero, IntPtr.Zero);

        CreateWindowEx(
            0, "BUTTON", "Disabled Win32 Button",
            WsChild | WsVisible | WsDisabled,
            20, 90, 180, 32, hwnd, (IntPtr)102, IntPtr.Zero, IntPtr.Zero);

        while (GetMessage(out var msg, IntPtr.Zero, 0, 0))
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
    }
}
