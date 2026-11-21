// Pilote Windows Terminal du poste de pilotage des sessions.
//
// Process RÉSIDENT, lancé et relancé par le serveur Node. Protocole : une requête JSON par ligne sur stdin
// ({"id":1,"op":"read","args":{"pid":1234}}), une réponse JSON par ligne sur stdout
// ({"id":1,"ok":true,"result":"…"} ou {"id":1,"ok":false,"error":"…"}), dans l'ordre où elles finissent.
// Les requêtes sont traitées en parallèle ; tout ce qui s'attache à une console passe par ConScreen.Gate
// (un process ne s'attache qu'à UNE console à la fois), le reste (toasts, inactivité clavier) ne l'attend pas.
//
// Le pilote n'a pas de console à lui (FreeConsole au démarrage, comme le serveur PowerShell) : il en a besoin
// pour s'attacher à celles des sessions. stdin/stdout sont ouverts AVANT, ce sont les tubes du serveur Node.
// stdin fermé (Node mort) ⇒ le pilote s'arrête : pas de pilote orphelin.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace SessionsDesk.Driver;

public static class Program
{
    public const string Version = "0.1.0";
    static readonly object WriteLock = new();
    static Stream? output;
    static bool testOps;

    public static int Main(string[] argv)
    {
        var args = new List<string>(argv);
        if (args.Contains("--version")) { Console.WriteLine(Version); return 0; }
        if (args.Contains("--fake-console")) return FakeConsole.Run(args);
        testOps = args.Contains("--test-ops");
        // Une requête bloque son thread tant qu'elle attend le verrou de la console : sans réserve, quelques lectures en
        // attente affament le pool (2 threads sur un poste à 2 cœurs) et un ping ou un toast attend ~1 s qu'il grossisse.
        ThreadPool.SetMinThreads(64, 64);

        // Tubes du serveur Node, pris AVANT de lâcher la console : AttachConsole ne doit pas les remplacer.
        var input = Console.OpenStandardInput();
        output = Console.OpenStandardOutput();
        ConScreen.Init();

        using var reader = new StreamReader(input, new UTF8Encoding(false), false, 1 << 16);
        string? line;
        var running = new List<Task>();
        while ((line = reader.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            var l = line;
            lock (running) { running.RemoveAll(t => t.IsCompleted); running.Add(Task.Run(() => Handle(l))); }
        }
        // stdin fermé : on rend les réponses déjà en route, sans attendre plus de 2 s une requête figée.
        Task[] last; lock (running) last = running.ToArray();
        Task.WaitAll(last, 2000);
        return 0;
    }

    static void Handle(string line)
    {
        JsonElement id = default; bool hasId = false;
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (root.TryGetProperty("id", out var idEl)) { id = idEl.Clone(); hasId = true; }
            string op = root.TryGetProperty("op", out var opEl) && opEl.ValueKind == JsonValueKind.String ? opEl.GetString()! : "";
            JsonElement a = root.TryGetProperty("args", out var argsEl) ? argsEl : default;
            object? result = Ops.Run(op, a, testOps);
            Reply(hasId ? id : (JsonElement?)null, true, result, null);
        }
        catch (OpException e) { Reply(hasId ? id : (JsonElement?)null, false, null, e.Message); }
        catch (JsonException e) { Reply(hasId ? id : (JsonElement?)null, false, null, "requête illisible : " + e.Message); }
        catch (Exception e) { Reply(hasId ? id : (JsonElement?)null, false, null, e.GetType().Name + " : " + e.Message); }
    }

    static void Reply(JsonElement? id, bool ok, object? result, string? error)
    {
        var buf = new MemoryStream();
        using (var w = new Utf8JsonWriter(buf, new JsonWriterOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
        {
            w.WriteStartObject();
            w.WritePropertyName("id");
            if (id is JsonElement e) e.WriteTo(w); else w.WriteNullValue();
            w.WriteBoolean("ok", ok);
            if (ok) { w.WritePropertyName("result"); Json.Write(w, result); }
            else w.WriteString("error", error);
            w.WriteEndObject();
        }
        buf.WriteByte((byte)'\n');
        lock (WriteLock)
        {
            try { output!.Write(buf.GetBuffer(), 0, (int)buf.Length); output.Flush(); }
            catch (IOException) { Environment.Exit(0); }   // tube fermé : Node est parti
        }
    }
}

/// <summary>Erreur d'usage (op inconnue, argument manquant) : renvoyée telle quelle au serveur.</summary>
public sealed class OpException(string message) : Exception(message);

static class Json
{
    public static void Write(Utf8JsonWriter w, object? v)
    {
        switch (v)
        {
            case null: w.WriteNullValue(); break;
            case string s: w.WriteStringValue(s); break;
            case bool b: w.WriteBooleanValue(b); break;
            case int i: w.WriteNumberValue(i); break;
            case long l: w.WriteNumberValue(l); break;
            case double d: w.WriteNumberValue(d); break;
            case IDictionary<string, object?> m:
                w.WriteStartObject();
                foreach (var kv in m) { w.WritePropertyName(kv.Key); Write(w, kv.Value); }
                w.WriteEndObject(); break;
            case System.Collections.IEnumerable list:
                w.WriteStartArray(); foreach (var x in list) Write(w, x); w.WriteEndArray(); break;
            default: w.WriteStringValue(v.ToString()); break;
        }
    }
}
