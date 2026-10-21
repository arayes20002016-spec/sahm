using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Sahm {
    public static class WindowsHttp {
        private const int MaxBody = 8 * 1024 * 1024;
        private const int MaxHeaders = 32768;
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024, RecursionLimit = 12 };

        private static string Text(Dictionary<string, object> value, string key) {
            object result;
            return value.TryGetValue(key, out result) ? result as string : null;
        }

        private static Dictionary<string, object> Object(Dictionary<string, object> value, string key) {
            object result;
            return value.TryGetValue(key, out result) ? result as Dictionary<string, object> : null;
        }

        private static ICredentials Credentials(Dictionary<string, object> auth, Uri address) {
            if (auth == null) return null;
            string scheme = Text(auth, "scheme");
            if (scheme != "NTLM" && scheme != "Negotiate" && scheme != "Basic") throw new ArgumentException();
            NetworkCredential credential;
            object current;
            if (auth.TryGetValue("currentAccount", out current) && current is bool && (bool)current) {
                credential = CredentialCache.DefaultNetworkCredentials;
            } else {
                Dictionary<string, object> saved = Object(auth, "credentials");
                if (saved == null) throw new ArgumentException();
                string user = Text(saved, "username"), password = Text(saved, "password");
                if (String.IsNullOrEmpty(user) || password == null) throw new ArgumentException();
                int separator = user.IndexOf('\\');
                credential = separator > 0 ? new NetworkCredential(user.Substring(separator + 1), password, user.Substring(0, separator)) : new NetworkCredential(user, password);
            }
            CredentialCache cache = new CredentialCache();
            cache.Add(new Uri(address.GetLeftPart(UriPartial.Authority) + "/"), scheme, credential);
            return cache;
        }

        private static void WriteLine(object value) {
            string line = Json.Serialize(value);
            if (Encoding.UTF8.GetByteCount(line) > MaxHeaders) throw new InvalidDataException();
            Console.Out.Write(line);
            Console.Out.Write('\n');
            Console.Out.Flush();
        }

        private static int Fail(bool headersSent, string code) {
            if (!headersSent) {
                try { WriteLine(new { error = code }); } catch { }
            }
            return 2;
        }

        public static int Run() {
            bool headersSent = false;
            try {
                string line = Console.In.ReadLine();
                if (line == null || line.Length > 32 * 1024 * 1024) return Fail(false, "invalid-request");
                Dictionary<string, object> spec = Json.DeserializeObject(line) as Dictionary<string, object>;
                if (spec == null) return Fail(false, "invalid-request");
                if (Object(spec, "clientCertificate") != null) return Fail(false, "certificate-requires-integrated-transport");
                Uri address;
                if (!Uri.TryCreate(Text(spec, "url"), UriKind.Absolute, out address) || (address.Scheme != "http" && address.Scheme != "https") || !String.IsNullOrEmpty(address.UserInfo)) return Fail(false, "invalid-request");
                ServicePointManager.SecurityProtocol = SecurityProtocolType.SystemDefault;
                using (HttpClientHandler handler = new HttpClientHandler()) {
                    handler.AllowAutoRedirect = false;
                    handler.UseProxy = false;
                    handler.UseCookies = false;
                    handler.UseDefaultCredentials = false;
                    handler.PreAuthenticate = false;
                    handler.AutomaticDecompression = DecompressionMethods.None;
                    handler.SslProtocols = System.Security.Authentication.SslProtocols.None;
                    handler.Credentials = Credentials(Object(spec, "serverAuth"), address);
                    Dictionary<string, object> route = Object(spec, "route");
                    if (route == null) return Fail(false, "invalid-request");
                    string type = Text(route, "type");
                    if (type == "http") {
                        Uri proxyAddress = new Uri(Text(route, "url"));
                        WebProxy proxy = new WebProxy(proxyAddress, false);
                        proxy.Credentials = Credentials(Object(spec, "proxyAuth"), proxyAddress);
                        handler.UseProxy = true;
                        handler.Proxy = proxy;
                    } else if (type != "direct") return Fail(false, "unsupported-route");

                    using (HttpClient client = new HttpClient(handler)) {
                        client.Timeout = Timeout.InfiniteTimeSpan;
                        using (HttpRequestMessage request = new HttpRequestMessage(new HttpMethod(Text(spec, "method")), address)) {
                            string encodedBody = Text(spec, "body");
                            if (encodedBody != null) {
                                byte[] body = Convert.FromBase64String(encodedBody);
                                if (body.Length > MaxBody) return Fail(false, "body-too-large");
                                request.Content = new ByteArrayContent(body);
                            }
                            object rawHeaders;
                            if (spec.TryGetValue("headers", out rawHeaders)) {
                                foreach (object pair in (IEnumerable)rawHeaders) {
                                    object[] header = pair as object[];
                                    if (header == null || header.Length != 2) return Fail(false, "invalid-request");
                                    string name = header[0] as string, value = header[1] as string;
                                    if (!request.Headers.TryAddWithoutValidation(name, value)) {
                                        if (request.Content == null) request.Content = new ByteArrayContent(new byte[0]);
                                        if (!request.Content.Headers.TryAddWithoutValidation(name, value)) return Fail(false, "invalid-request");
                                    }
                                }
                            }
                            using (CancellationTokenSource timeout = new CancellationTokenSource()) {
                                timeout.CancelAfter(Convert.ToInt32(spec["headersTimeoutMs"]));
                                using (HttpResponseMessage response = client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).GetAwaiter().GetResult()) {
                                    timeout.CancelAfter(Timeout.Infinite);
                                    List<string[]> headers = new List<string[]>();
                                    foreach (KeyValuePair<string, IEnumerable<string>> header in response.Headers) foreach (string value in header.Value) headers.Add(new string[] { header.Key, value });
                                    if (response.Content != null) foreach (KeyValuePair<string, IEnumerable<string>> header in response.Content.Headers) foreach (string value in header.Value) headers.Add(new string[] { header.Key, value });
                                    WriteLine(new { status = (int)response.StatusCode, headers = headers });
                                    headersSent = true;
                                    if (Text(spec, "method") != "HEAD" && response.Content != null) {
                                        using (Stream input = response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()) {
                                            Stream output = Console.OpenStandardOutput();
                                            byte[] buffer = new byte[32768];
                                            int read; long received = 0;
                                            while ((read = input.Read(buffer, 0, buffer.Length)) > 0) { output.Write(buffer, 0, read); received += read; }
                                            long? expected = response.Content.Headers.ContentLength;
                                            if (expected.HasValue && received != expected.Value) throw new IOException();
                                            output.Flush();
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                return 0;
            } catch (OperationCanceledException) { return Fail(headersSent, "headers-timeout"); }
            catch (HttpRequestException) { return Fail(headersSent, "request-failed"); }
            catch (InvalidDataException) { return Fail(headersSent, "headers-too-large"); }
            catch { return Fail(headersSent, "request-failed"); }
        }
    }
}
