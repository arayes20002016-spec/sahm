using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace SahmWindowsAuth {
  public sealed class SspiException : Exception {
    public readonly uint Status;
    public SspiException(int status) : base("Windows authentication failed") { Status = unchecked((uint)status); }
  }

  [StructLayout(LayoutKind.Sequential)] public struct SecHandle { public IntPtr Low; public IntPtr High; }
  [StructLayout(LayoutKind.Sequential)] public struct SecBuffer { public int Length; public int Type; public IntPtr Pointer; }
  [StructLayout(LayoutKind.Sequential)] public struct SecBufferDesc { public int Version; public int Count; public IntPtr Buffers; }
  [StructLayout(LayoutKind.Sequential)] internal struct AuthIdentity {
    public IntPtr User; public uint UserLength;
    public IntPtr Domain; public uint DomainLength;
    public IntPtr Password; public uint PasswordLength; public uint Flags;
  }
  [StructLayout(LayoutKind.Sequential)] internal struct PackageInfo {
    public uint Capabilities; public ushort Version; public ushort RpcId; public uint MaximumToken;
    public IntPtr Name; public IntPtr Comment;
  }
  [StructLayout(LayoutKind.Sequential)] internal struct NegotiationInfo { public IntPtr Package; public uint State; }

  internal static class Native {
    [DllImport("secur32.dll", CharSet=CharSet.Unicode, SetLastError=false)]
    internal static extern int AcquireCredentialsHandleW(string principal, string package, uint use, IntPtr logon, IntPtr identity, IntPtr getKey, IntPtr keyArgument, out SecHandle credentials, out long expiry);
    [DllImport("secur32.dll", CharSet=CharSet.Unicode, SetLastError=false)]
    internal static extern int InitializeSecurityContextW(ref SecHandle credentials, IntPtr previous, string target, uint flags, uint reserved, uint representation, IntPtr input, uint reserved2, out SecHandle context, ref SecBufferDesc output, out uint attributes, out long expiry);
    [DllImport("secur32.dll")] internal static extern int CompleteAuthToken(ref SecHandle context, ref SecBufferDesc token);
    [DllImport("secur32.dll")] internal static extern int DeleteSecurityContext(ref SecHandle context);
    [DllImport("secur32.dll")] internal static extern int FreeCredentialsHandle(ref SecHandle credentials);
    [DllImport("secur32.dll")] internal static extern int FreeContextBuffer(IntPtr pointer);
    [DllImport("secur32.dll", CharSet=CharSet.Unicode)] internal static extern int QueryContextAttributesW(ref SecHandle context, uint attribute, out IntPtr package);
    [DllImport("secur32.dll", EntryPoint="QueryContextAttributesW", CharSet=CharSet.Unicode)] internal static extern int QueryNegotiationAttributes(ref SecHandle context, uint attribute, out NegotiationInfo package);
  }

  // All unmanaged allocations belong to one SSPI call. SSPI owns its output
  // token; input buffers and the descriptor arrays are owned here.
  internal sealed class InputBuffers : IDisposable {
    internal IntPtr Descriptor;
    readonly List<IntPtr> allocations = new List<IntPtr>();
    internal InputBuffers(byte[] token, byte[] applicationBinding) {
      List<SecBuffer> buffers = new List<SecBuffer>();
      if (token != null && token.Length > 0) buffers.Add(Create(token, 2));
      if (applicationBinding != null && applicationBinding.Length > 0) {
        byte[] binding = new byte[32 + applicationBinding.Length];
        Array.Copy(BitConverter.GetBytes(applicationBinding.Length), 0, binding, 24, 4);
        Array.Copy(BitConverter.GetBytes(32), 0, binding, 28, 4);
        Array.Copy(applicationBinding, 0, binding, 32, applicationBinding.Length);
        buffers.Add(Create(binding, 14));
      }
      if (buffers.Count == 0) return;
      int size = Marshal.SizeOf(typeof(SecBuffer));
      IntPtr array = Allocate(size * buffers.Count);
      for (int index = 0; index < buffers.Count; index++) Marshal.StructureToPtr(buffers[index], IntPtr.Add(array, size * index), false);
      Descriptor = Allocate(Marshal.SizeOf(typeof(SecBufferDesc)));
      Marshal.StructureToPtr(new SecBufferDesc { Version=0, Count=buffers.Count, Buffers=array }, Descriptor, false);
    }
    IntPtr Allocate(int size) { IntPtr pointer = Marshal.AllocHGlobal(size); allocations.Add(pointer); return pointer; }
    SecBuffer Create(byte[] bytes, int type) { IntPtr pointer = Allocate(bytes.Length); Marshal.Copy(bytes, 0, pointer, bytes.Length); return new SecBuffer { Length=bytes.Length, Type=type, Pointer=pointer }; }
    public void Dispose() { foreach (IntPtr pointer in allocations) Marshal.FreeHGlobal(pointer); allocations.Clear(); Descriptor=IntPtr.Zero; }
  }

  public sealed class StepResult {
    public string Token; public bool Complete; public string Package; public uint Attributes;
  }

  public sealed class ClientContext : IDisposable {
    SecHandle credentials, context;
    bool hasCredentials, hasContext, closed;
    readonly string target, package;
    readonly byte[] binding;
    int steps;

    public ClientContext(string scheme, string host, bool currentAccount, string username, string password, string domain, string channelBinding) {
      switch (scheme) {
        case "ntlm": package="NTLM"; break;
        case "negotiate": package="Negotiate"; break;
        case "kerberos": package="Kerberos"; break;
        default: throw new ArgumentException("Invalid authentication parameters");
      }
      if (String.IsNullOrEmpty(host)) throw new ArgumentException("Invalid authentication parameters");
      target = "HTTP/" + host;
      binding = String.IsNullOrEmpty(channelBinding) ? null : Convert.FromBase64String(channelBinding);
      IntPtr user=IntPtr.Zero, secret=IntPtr.Zero, realm=IntPtr.Zero, identity=IntPtr.Zero;
      try {
        if (!currentAccount) {
          if (String.IsNullOrEmpty(username) || password == null) throw new ArgumentException("Credentials required");
          user=Marshal.StringToHGlobalUni(username); secret=Marshal.StringToHGlobalUni(password); realm=Marshal.StringToHGlobalUni(domain ?? "");
          AuthIdentity value = new AuthIdentity { User=user, UserLength=(uint)username.Length, Password=secret, PasswordLength=(uint)password.Length, Domain=realm, DomainLength=(uint)(domain ?? "").Length, Flags=2 };
          identity=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(AuthIdentity))); Marshal.StructureToPtr(value, identity, false);
        }
        long expiry;
        int result=Native.AcquireCredentialsHandleW(null, package, 2, IntPtr.Zero, identity, IntPtr.Zero, IntPtr.Zero, out credentials, out expiry);
        if (result != 0) throw new SspiException(result);
        hasCredentials=true;
      } finally {
        if (identity != IntPtr.Zero) Marshal.FreeHGlobal(identity);
        if (user != IntPtr.Zero) Marshal.ZeroFreeGlobalAllocUnicode(user);
        if (secret != IntPtr.Zero) Marshal.ZeroFreeGlobalAllocUnicode(secret);
        if (realm != IntPtr.Zero) Marshal.ZeroFreeGlobalAllocUnicode(realm);
      }
    }

    public StepResult Step(string challenge) {
      if (closed || ++steps > 4) throw new InvalidOperationException("Authentication context is closed or exhausted");
      byte[] token=String.IsNullOrEmpty(challenge) ? null : Convert.FromBase64String(challenge);
      IntPtr old=IntPtr.Zero, output=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecBuffer)));
      Marshal.StructureToPtr(new SecBuffer { Length=0, Type=2, Pointer=IntPtr.Zero }, output, false);
      SecBufferDesc descriptor=new SecBufferDesc { Version=0, Count=1, Buffers=output };
      try {
        if (hasContext) { old=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecHandle))); Marshal.StructureToPtr(context, old, false); }
        using (InputBuffers input=new InputBuffers(token, binding)) {
          SecHandle next; uint attributes; long expiry;
          // Request Kerberos mutual authentication in Negotiate as well. Windows
          // can still select NTLM; the returned package identifies that fallback.
          uint flags=0x100u | 0x800u | (package != "NTLM" ? 2u : 0u);
          int result=Native.InitializeSecurityContextW(ref credentials, old, target, flags, 0, 0x10, input.Descriptor, 0, out next, ref descriptor, out attributes, out expiry);
          if (next.Low != IntPtr.Zero || next.High != IntPtr.Zero) { context=next; hasContext=true; }
          bool complete=result == 0 || result == 0x90313;
          if (result == 0x90313 || result == 0x90314) { int completed=Native.CompleteAuthToken(ref context, ref descriptor); if (completed != 0) throw new SspiException(completed); }
          if (result != 0 && result != 0x90312 && result != 0x90313 && result != 0x90314) throw new SspiException(result);
          SecBuffer buffer=(SecBuffer)Marshal.PtrToStructure(output, typeof(SecBuffer));
          if (buffer.Length < 0 || buffer.Length > 131072) throw new InvalidOperationException("Invalid output token size");
          byte[] bytes=new byte[buffer.Length]; if (bytes.Length > 0) Marshal.Copy(buffer.Pointer, bytes, 0, bytes.Length);
          return new StepResult { Token=Convert.ToBase64String(bytes), Complete=complete, Package=complete ? NegotiatedPackage() : null, Attributes=attributes };
        }
      } catch { Dispose(); throw; }
      finally {
        SecBuffer buffer=(SecBuffer)Marshal.PtrToStructure(output, typeof(SecBuffer));
        if (buffer.Pointer != IntPtr.Zero) Native.FreeContextBuffer(buffer.Pointer);
        Marshal.FreeHGlobal(output); if (old != IntPtr.Zero) Marshal.FreeHGlobal(old);
      }
    }

    string NegotiatedPackage() {
      IntPtr information;
      if (package == "Negotiate") {
        NegotiationInfo negotiated;
        if (Native.QueryNegotiationAttributes(ref context, 12, out negotiated) != 0 || negotiated.Package == IntPtr.Zero) return package;
        information=negotiated.Package;
      } else if (Native.QueryContextAttributesW(ref context, 10, out information) != 0 || information == IntPtr.Zero) return package;
      try { return Marshal.PtrToStringUni(((PackageInfo)Marshal.PtrToStructure(information, typeof(PackageInfo))).Name); }
      finally { Native.FreeContextBuffer(information); }
    }

    public void Dispose() {
      if (closed) return; closed=true;
      if (hasContext) { Native.DeleteSecurityContext(ref context); hasContext=false; }
      if (hasCredentials) { Native.FreeCredentialsHandle(ref credentials); hasCredentials=false; }
    }
  }
}
