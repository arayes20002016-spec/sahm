using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Web.Script.Serialization;

namespace Sahm {
    public static class ClientCertificateIdentity {
        private const int MaxBytes = 8 * 1024 * 1024;
        private static string B64(byte[] value) {
            if (value == null || value.Length == 0) throw new InvalidOperationException();
            return Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }
        private static void AllowMemoryExport(CngKey key) {
            if (!key.IsEphemeral) throw new InvalidOperationException();
            // The imported software key exists only in this process. Set its export
            // policy before use; EphemeralKeySet alone permits encrypted export only.
            key.SetProperty(new CngProperty("Export Policy", BitConverter.GetBytes((int)(CngExportPolicies.AllowExport | CngExportPolicies.AllowPlaintextExport)), CngPropertyOptions.None));
        }
        private static string CurveName(ECCurve curve) {
            string oid = curve.Oid.Value, name = curve.Oid.FriendlyName;
            if (oid == "1.2.840.10045.3.1.7" || name == "nistP256") return "P-256";
            if (oid == "1.3.132.0.34" || name == "nistP384") return "P-384";
            if (oid == "1.3.132.0.35" || name == "nistP521") return "P-521";
            throw new InvalidOperationException();
        }
        private static Dictionary<string, object> Key(X509Certificate2 certificate) {
            using (RSA rsa = certificate.GetRSAPrivateKey()) {
                if (rsa != null) {
                    RSACng cngRsa = rsa as RSACng;
                    if (cngRsa != null) AllowMemoryExport(cngRsa.Key);
                    RSAParameters p = rsa.ExportParameters(true);
                    return new Dictionary<string, object> { {"kty", "RSA"}, {"n", B64(p.Modulus)}, {"e", B64(p.Exponent)}, {"d", B64(p.D)}, {"p", B64(p.P)}, {"q", B64(p.Q)}, {"dp", B64(p.DP)}, {"dq", B64(p.DQ)}, {"qi", B64(p.InverseQ)} };
                }
            }
            using (ECDsa ec = certificate.GetECDsaPrivateKey()) {
                if (ec == null) throw new InvalidOperationException();
                ECDsaCng cng = ec as ECDsaCng;
                if (cng != null) AllowMemoryExport(cng.Key);
                ECParameters p = ec.ExportParameters(true);
                return new Dictionary<string, object> { {"kty", "EC"}, {"crv", CurveName(p.Curve)}, {"x", B64(p.Q.X)}, {"y", B64(p.Q.Y)}, {"d", B64(p.D)} };
            }
        }
        public static void Run() {
            JavaScriptSerializer json = new JavaScriptSerializer();
            json.MaxJsonLength = 16 * 1024 * 1024;
            X509Certificate2Collection certificates = new X509Certificate2Collection();
            byte[] bytes = null;
            try {
                StringBuilder source = new StringBuilder();
                char[] chunk = new char[65536]; int read;
                while ((read = Console.In.Read(chunk, 0, chunk.Length)) > 0) {
                    if (source.Length + read > 12 * 1024 * 1024) throw new InvalidOperationException();
                    source.Append(chunk, 0, read);
                }
                Dictionary<string, object> input = json.Deserialize<Dictionary<string, object>>(source.ToString());
                if (input == null || input.Count != 2 || !input.ContainsKey("pfx") || !input.ContainsKey("passphrase") || !(input["pfx"] is string) || !(input["passphrase"] is string)) throw new InvalidOperationException();
                string passphrase = (string)input["passphrase"];
                if (passphrase.Length > 4096) throw new InvalidOperationException();
                bytes = Convert.FromBase64String((string)input["pfx"]);
                if (bytes.Length == 0 || bytes.Length > MaxBytes) throw new InvalidOperationException();
                // EphemeralKeySet (32) prevents persistence in the Windows key store.
                certificates.Import(bytes, passphrase, X509KeyStorageFlags.Exportable | (X509KeyStorageFlags)32);
                if (certificates.Count == 0 || certificates.Count > 64) throw new InvalidOperationException();
                X509Certificate2 identity = null;
                foreach (X509Certificate2 certificate in certificates) {
                    if (!certificate.HasPrivateKey) continue;
                    if (identity != null) throw new InvalidOperationException();
                    identity = certificate;
                }
                if (identity == null) throw new InvalidOperationException();
                string leaf = Convert.ToBase64String(identity.RawData);
                List<string> chain = new List<string>(); chain.Add(leaf);
                int total = identity.RawData.Length;
                foreach (X509Certificate2 certificate in certificates) {
                    string encoded = Convert.ToBase64String(certificate.RawData);
                    if (chain.Contains(encoded)) continue;
                    total += certificate.RawData.Length;
                    if (total > MaxBytes) throw new InvalidOperationException();
                    chain.Add(encoded);
                }
                Console.Out.Write(json.Serialize(new { ok = true, certificates = chain, jwk = Key(identity) }));
            } catch {
                Console.Out.Write(json.Serialize(new { ok = false, code = "CLIENT_CERTIFICATE_EXTRACT" }));
            } finally {
                foreach (X509Certificate2 certificate in certificates) certificate.Dispose();
                if (bytes != null) Array.Clear(bytes, 0, bytes.Length);
            }
        }
    }
}
