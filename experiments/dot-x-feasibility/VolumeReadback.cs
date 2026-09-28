// Reads the volume and mute state of the audio sessions a process owns on the default output device, straight from
// Windows Core Audio. It shares no code with Dot X. Usage: rqa-volume-readback.exe <pid>. Prints one JSON line:
// {"pid":1234,"sessions":[{"volume":0.5,"muted":false}]}; no session for that pid prints an empty list.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;

public static class VolumeReadback
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        int GetAudioSessionControl(IntPtr groupingParam, int flags, out IntPtr control);
        int GetSimpleAudioVolume(IntPtr groupingParam, int flags, out IntPtr volume);
        int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        int GetCount(out int count);
        int GetSession(int index, out IAudioSessionControl2 session);
    }

    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        int GetState(out int state);
        int GetDisplayName(out IntPtr name);
        int SetDisplayName(string name, ref Guid context);
        int GetIconPath(out IntPtr path);
        int SetIconPath(string path, ref Guid context);
        int GetGroupingParam(out Guid param);
        int SetGroupingParam(ref Guid param, ref Guid context);
        int RegisterAudioSessionNotification(IntPtr client);
        int UnregisterAudioSessionNotification(IntPtr client);
        int GetSessionIdentifier(out IntPtr id);
        int GetSessionInstanceIdentifier(out IntPtr id);
        int GetProcessId(out uint pid);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume
    {
        int SetMasterVolume(float level, ref Guid context);
        int GetMasterVolume(out float level);
        // BOOL is 4 bytes; a bool in a COM interface would otherwise marshal as 2-byte VARIANT_BOOL.
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    public static int Main(string[] args)
    {
        uint pid;
        if (args.Length != 1 || !uint.TryParse(args[0], out pid)) { Console.Error.WriteLine("usage: rqa-volume-readback.exe <pid>"); return 2; }
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0 /* render */, 1 /* multimedia */, out device));
        var iid = typeof(IAudioSessionManager2).GUID;
        object manager;
        Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out manager));
        IAudioSessionEnumerator sessions;
        Marshal.ThrowExceptionForHR(((IAudioSessionManager2)manager).GetSessionEnumerator(out sessions));
        int count;
        Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
        var found = new List<string>();
        for (int i = 0; i < count; i++)
        {
            IAudioSessionControl2 control;
            Marshal.ThrowExceptionForHR(sessions.GetSession(i, out control));
            uint owner;
            // Another process's session can fail here (a multi-process session reports AUDCLNT_S_NO_SINGLE_PROCESS);
            // it is not the one being read, so only a session that names this pid counts.
            if (control.GetProcessId(out owner) != 0 || owner != pid) continue;
            var volume = (ISimpleAudioVolume)control;
            float level;
            bool muted;
            // A failure here is an error, never a sample: the probe must not record a volume that was not read.
            Marshal.ThrowExceptionForHR(volume.GetMasterVolume(out level));
            Marshal.ThrowExceptionForHR(volume.GetMute(out muted));
            found.Add(string.Format(CultureInfo.InvariantCulture, "{{\"volume\":{0:0.0000},\"muted\":{1}}}", level, muted ? "true" : "false"));
        }
        Console.WriteLine("{\"pid\":" + pid + ",\"sessions\":[" + string.Join(",", found) + "]}");
        return 0;
    }
}
