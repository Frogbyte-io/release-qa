// A process with a uniquely named executable that plays a near-silent tone in a loop, so Windows gives it its own audio
// session. Usage: rqa-audio-fixture.exe <seconds>. It exits by itself after that many seconds.
using System;
using System.IO;
using System.Media;
using System.Reflection;
using System.Threading;

[assembly: AssemblyTitle("rqa-audio-fixture")]
[assembly: AssemblyProduct("rqa-audio-fixture")]

public static class AudioFixture
{
    public static void Main(string[] args)
    {
        int seconds;
        if (args.Length == 0) seconds = 600;
        else if (!int.TryParse(args[0], out seconds) || seconds <= 0) { Console.Error.WriteLine("usage: rqa-audio-fixture.exe [seconds > 0]"); Environment.Exit(2); return; }
        // One second of a 440 Hz tone at amplitude 2 of 32767: inaudible, but real samples, so the session is active.
        const int rate = 44100;
        var wav = new MemoryStream();
        var w = new BinaryWriter(wav);
        w.Write(new[] { 'R', 'I', 'F', 'F' }); w.Write(36 + rate * 2); w.Write(new[] { 'W', 'A', 'V', 'E' });
        w.Write(new[] { 'f', 'm', 't', ' ' }); w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(rate); w.Write(rate * 2); w.Write((short)2); w.Write((short)16);
        w.Write(new[] { 'd', 'a', 't', 'a' }); w.Write(rate * 2);
        for (int i = 0; i < rate; i++) w.Write((short)Math.Round(2 * Math.Sin(2 * Math.PI * 440 * i / rate)));
        wav.Position = 0;
        var player = new SoundPlayer(wav);
        player.PlayLooping();
        Console.WriteLine("playing");
        Thread.Sleep(TimeSpan.FromSeconds(seconds));
        player.Stop();
    }
}
