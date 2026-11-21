// ConScreen — extraite TELLE QUELLE de legacy/sessions-dashboard.ps1 (lignes 822-1003, commit a9e92eb).
// Le .ps1 n'est pas dans ce dépôt : server/test/conscreen-verbatim.test.ts ne compare les deux blocs que là où
// legacy/ est présent.
#nullable disable
using System; using System.Text; using System.Runtime.InteropServices;
public static class ConScreen {
    // Un process ne s'attache qu'à UNE console : tout ce qui s'attache passe par ce verrou.
    public static readonly object Gate = new object();
    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] struct INFO { public COORD Size; public COORD Cursor; public ushort Attr; public SMALL_RECT Win; public COORD Max; }
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    // AttachConsole est refusé PASSAGÈREMENT (ERROR_INVALID_FUNCTION, code 1) quand un thread du process naît ou meurt au
    // même instant — mesuré le 18/11/2026 : 22 à 27 % des attaches sous création de threads, 0 sans ; threads natifs
    // comme .NET. Le pool de threads en crée en rafale : sans nouvel essai, une session ouverte serait lue « illisible ».
    // Code 1 seulement (process mort, pas de console : refus immédiat, comme avant) ; 5 essais au plus, 0 à 3 ms d'écart.
    static bool Attach(uint pid) {
        for (int i = 0; ; i++) {
            if (AttachConsole(pid)) return true;
            if (Marshal.GetLastWin32Error() != 1 || i == 4) return false;
            System.Threading.Thread.Sleep(i);
        }
    }
    [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out INFO i);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder sb, uint len, COORD c, out uint read);
    public static void Init() { SetConsoleCtrlHandler(IntPtr.Zero, true); FreeConsole(); }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetConsoleTitleW(StringBuilder sb, uint n);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);
    [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO i);
    public static string Title(uint pid) { lock (Gate) return TitleCore(pid); }
    static string TitleCore(uint pid) {
        FreeConsole();
        if (!Attach(pid)) return null;
        try { var sb = new StringBuilder(2048); GetConsoleTitleW(sb, 2048); return sb.ToString(); } finally { FreeConsole(); }
    }
    // Titre de la fenêtre au premier plan si c'est Windows Terminal (= titre de son onglet actif), sinon null.
    public static string ForegroundTerminalTitle() {
        IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero) return null;
        var c = new StringBuilder(256); GetClassNameW(h, c, 256);
        if (c.ToString() != "CASCADIA_HOSTING_WINDOW_CLASS") return null;
        var t = new StringBuilder(2048); GetWindowTextW(h, t, 2048); return t.ToString();
    }
    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    struct INPUT_RECORD {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public int bKeyDown;
        [FieldOffset(8)] public ushort wRepeatCount;
        [FieldOffset(10)] public ushort wVirtualKeyCode;
        [FieldOffset(12)] public ushort wVirtualScanCode;
        [FieldOffset(14)] public char UnicodeChar;
        [FieldOffset(16)] public uint dwControlKeyState;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] buf, uint len, out uint written);
    static bool Type(string text) {
        IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h == new IntPtr(-1)) return false;
        try {
            var recs = new INPUT_RECORD[text.Length * 2];
            for (int i = 0; i < text.Length; i++) {
                var r = new INPUT_RECORD { EventType = 1, wRepeatCount = 1, UnicodeChar = text[i] };
                if (text[i] == '\r') { r.wVirtualKeyCode = 0x0D; r.wVirtualScanCode = 0x1C; }
                r.bKeyDown = 1; recs[2 * i] = r; r.bKeyDown = 0; recs[2 * i + 1] = r;
            }
            uint n; return WriteConsoleInputW(h, recs, (uint)recs.Length, out n);
        } finally { CloseHandle(h); }
    }
    // Invite vide = le curseur est juste après « ❯ » sur sa ligne (un brouillon le déplace).
    static bool PromptIsEmpty() {
        IntPtr h = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h == new IntPtr(-1)) return false;
        try {
            INFO i; if (!GetConsoleScreenBufferInfo(h, out i)) return false;
            var sb = new StringBuilder(8); uint r;
            if (!ReadConsoleOutputCharacterW(h, sb, 2, new COORD { X = 0, Y = i.Cursor.Y }, out r) || r < 1) return false;
            return sb[0] == '\u276F' && i.Cursor.X == 2;
        } finally { CloseHandle(h); }
    }
    // PROPOSITION DE PROMPT de Claude Code : texte grisé affiché DANS l'invite vide après un tour (« ❯ ouvre la PR »),
    // validé par Tab dans le terminal. Même critère que PromptIsEmpty — curseur resté juste après « ❯ » — : ce qui est
    // lu ici est donc exactement ce que Send écraserait, et un brouillon (qui déplace le curseur) n'est jamais pris pour
    // une proposition. Lignes suivantes jusqu'au bord « ─── » de l'invite = suite d'une proposition repliée.
    public static string Suggestion(uint pid) {
        lock (Gate) {
            FreeConsole();
            if (!Attach(pid)) return null;
            try { return SuggestionCore(); } finally { FreeConsole(); }
        }
    }
    static string SuggestionCore() {
        IntPtr h = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h == new IntPtr(-1)) return null;
        try {
            INFO i; if (!GetConsoleScreenBufferInfo(h, out i) || i.Cursor.X != 2 || i.Size.X < 4) return null;
            var parts = new System.Collections.Generic.List<string>();
            for (int y = i.Cursor.Y; y < i.Size.Y && y < i.Cursor.Y + 8; y++) {
                var sb = new StringBuilder(i.Size.X + 1); uint r;
                if (!ReadConsoleOutputCharacterW(h, sb, (uint)i.Size.X, new COORD { X = 0, Y = (short)y }, out r)) break;
                string line = sb.ToString();                     // tampon non terminé : ne garder que les r caractères lus
                line = line.Substring(0, (int)Math.Min((uint)line.Length, r)).Replace(' ', ' ');
                if (y == i.Cursor.Y) {
                    if (line.Length < 3 || line[0] != '❯') return null;
                    parts.Add(line.Substring(2).Trim());
                } else {
                    string t = line.Trim();
                    if (t.Length == 0 || t[0] == '─') break;
                    parts.Add(t);
                }
            }
            string s = string.Join(" ", parts).Trim();
            return s.Length == 0 ? null : s;
        } finally { CloseHandle(h); }
    }
    // Tape une ligne puis Entrée. 0 envoyé · 2 console inaccessible · 5 invite non vide (brouillon, menu, dialogue).
    public static int Send(uint pid, string line) { lock (Gate) return SendCore(pid, line); }
    static int SendCore(uint pid, string line) {
        FreeConsole();
        if (!Attach(pid)) return 2;
        try {
            if (!PromptIsEmpty()) return 5;
            if (!Type(line)) return 2;
            System.Threading.Thread.Sleep(500);      // Entrée à part : sinon lue comme un collage
            return Type("\r") ? 0 : 2;
        } finally { FreeConsole(); }
    }
    // Touches pour répondre à un dialogue. Élément « \u0001Nom » = touche nommée, sinon texte tapé tel quel.
    // Pause entre éléments : Ink lit une rafale comme un collage, et un chiffre suivi d'Entrée serait fusionné.
    static INPUT_RECORD Key(ushort vk, ushort sc, char ch, uint ctrl, bool down) {
        return new INPUT_RECORD { EventType = 1, bKeyDown = down ? 1 : 0, wRepeatCount = 1, wVirtualKeyCode = vk, wVirtualScanCode = sc, UnicodeChar = ch, dwControlKeyState = ctrl };
    }
    public static int SendKeys(uint pid, string[] items) { lock (Gate) return SendKeysCore(pid, items); }
    static int SendKeysCore(uint pid, string[] items) {
        FreeConsole();
        if (!Attach(pid)) return 2;
        try {
            foreach (var it in items) {
                if (it.Length > 0 && it[0] == '\u0001') {
                    ushort vk = 0, sc = 0; char ch = '\0'; uint ctrl = 0;
                    switch (it.Substring(1)) {
                        case "Enter": vk = 0x0D; sc = 0x1C; ch = '\r'; break;
                        case "Esc": vk = 0x1B; sc = 0x01; ch = '\u001b'; break;
                        case "Up": vk = 0x26; sc = 0x48; ctrl = 0x100; break;
                        case "Down": vk = 0x28; sc = 0x50; ctrl = 0x100; break;
                        case "Left": vk = 0x25; sc = 0x4B; ctrl = 0x100; break;
                        case "Right": vk = 0x27; sc = 0x4D; ctrl = 0x100; break;
                        case "Tab": vk = 0x09; sc = 0x0F; ch = '\t'; break;
                        case "ShiftTab": vk = 0x09; sc = 0x0F; ch = '\t'; ctrl = 0x10; break;
                        case "Space": vk = 0x20; sc = 0x39; ch = ' '; break;
                        case "Backspace": vk = 0x08; sc = 0x0E; ch = '\b'; break;
                        default: return 3;
                    }
                    IntPtr h = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
                    if (h == new IntPtr(-1)) return 2;
                    try { uint n; if (!WriteConsoleInputW(h, new[] { Key(vk, sc, ch, ctrl, true), Key(vk, sc, ch, ctrl, false) }, 2, out n)) return 2; }
                    finally { CloseHandle(h); }
                    System.Threading.Thread.Sleep(200);
                } else {
                    if (!Type(it)) return 2;
                    System.Threading.Thread.Sleep(500);
                }
            }
            return 0;
        } finally { FreeConsole(); }
    }
    public static double IdleSeconds() {
        var i = new LASTINPUTINFO(); i.cbSize = (uint)Marshal.SizeOf(i);
        return GetLastInputInfo(ref i) ? unchecked((uint)Environment.TickCount - i.dwTime) / 1000.0 : 0;
    }
    public static string Read(uint pid) { lock (Gate) return ReadCore(pid); }
    static string ReadCore(uint pid) {
        FreeConsole();
        if (!Attach(pid)) return null;
        try {
            IntPtr h = CreateFileW("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (h == new IntPtr(-1)) return null;
            try {
                INFO i; if (!GetConsoleScreenBufferInfo(h, out i)) return null;
                var all = new StringBuilder();
                for (short y = i.Win.T; y <= i.Win.B; y++) {
                    var sb = new StringBuilder(i.Size.X + 1); uint r;
                    ReadConsoleOutputCharacterW(h, sb, (uint)i.Size.X, new COORD { X = 0, Y = y }, out r);
                    all.Append(sb.ToString(0, (int)r).TrimEnd()).Append('\n');
                }
                return all.ToString().TrimEnd();
            } finally { CloseHandle(h); }
        } finally { FreeConsole(); }
    }
}
