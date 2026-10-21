namespace SahmWindowsAuth {
  // Compiled only by the local SSPI tests. This inbound context is excluded
  // from production packaging by the existing test/ ignore rule.
  public sealed class ServerContext : IDisposable {
    [DllImport("secur32.dll")] static extern int AcceptSecurityContext(ref SecHandle credentials, IntPtr previous, IntPtr input, uint flags, uint representation, out SecHandle context, ref SecBufferDesc output, out uint attributes, out long expiry);
    SecHandle credentials, context;
    bool hasCredentials, hasContext, closed;
    readonly byte[] binding;
    readonly string package;
    public ServerContext(string scheme, string host, bool currentAccount, string username, string password, string domain, string channelBinding) {
      package=scheme == "ntlm" ? "NTLM" : scheme == "negotiate" ? "Negotiate" : "Kerberos";
      if (!currentAccount) throw new InvalidOperationException("The fixture requires the current Windows identity");
      binding=String.IsNullOrEmpty(channelBinding) ? null : Convert.FromBase64String(channelBinding);
      long expiry; int result=Native.AcquireCredentialsHandleW(null, package, 1, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out credentials, out expiry);
      if (result != 0) throw new SspiException(result); hasCredentials=true;
    }
    public StepResult Step(string challenge) {
      if (closed || String.IsNullOrEmpty(challenge)) throw new InvalidOperationException("Invalid fixture state");
      byte[] token=Convert.FromBase64String(challenge);
      IntPtr old=IntPtr.Zero, output=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecBuffer)));
      Marshal.StructureToPtr(new SecBuffer { Length=0, Type=2, Pointer=IntPtr.Zero }, output, false);
      SecBufferDesc descriptor=new SecBufferDesc { Version=0, Count=1, Buffers=output };
      try {
        if (hasContext) { old=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecHandle))); Marshal.StructureToPtr(context, old, false); }
        using (InputBuffers input=new InputBuffers(token, binding)) {
          SecHandle next; uint attributes; long expiry;
          int result=AcceptSecurityContext(ref credentials, old, input.Descriptor, 0x100u | 0x800u, 0x10, out next, ref descriptor, out attributes, out expiry);
          if (next.Low != IntPtr.Zero || next.High != IntPtr.Zero) { context=next; hasContext=true; }
          bool complete=result == 0 || result == 0x90313;
          if (result == 0x90313 || result == 0x90314) { int completed=Native.CompleteAuthToken(ref context, ref descriptor); if (completed != 0) throw new SspiException(completed); }
          if (result != 0 && result != 0x90312 && result != 0x90313 && result != 0x90314) throw new SspiException(result);
          SecBuffer buffer=(SecBuffer)Marshal.PtrToStructure(output, typeof(SecBuffer));
          byte[] bytes=new byte[buffer.Length]; if (bytes.Length > 0) Marshal.Copy(buffer.Pointer, bytes, 0, bytes.Length);
          return new StepResult { Token=Convert.ToBase64String(bytes), Complete=complete, Package=complete ? package : null, Attributes=attributes };
        }
      } finally {
        SecBuffer buffer=(SecBuffer)Marshal.PtrToStructure(output, typeof(SecBuffer));
        if (buffer.Pointer != IntPtr.Zero) Native.FreeContextBuffer(buffer.Pointer);
        Marshal.FreeHGlobal(output); if (old != IntPtr.Zero) Marshal.FreeHGlobal(old);
      }
    }
    public void Dispose() {
      if (closed) return; closed=true;
      if (hasContext) { Native.DeleteSecurityContext(ref context); hasContext=false; }
      if (hasCredentials) { Native.FreeCredentialsHandle(ref credentials); hasCredentials=false; }
    }
  }
}
