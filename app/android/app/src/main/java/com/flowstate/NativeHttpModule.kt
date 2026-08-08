package com.flowstate

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * NATIVE HTTP for stream-URL resolution -- exposed as `NativeModules.NativeHttp`.
 *
 * WHY THIS EXISTS: React Native's own `fetch`/XHR stalls when the app is
 * backgrounded on this device (measured: even a plain fetch to a trivial
 * endpoint never returns with the screen off). That's what killed notification
 * skips once the pre-buffered songs ran out -- every skip needs a fresh
 * youtubei.js resolve, and that resolve rode RN's frozen fetch. ExoPlayer keeps
 * streaming backgrounded because it does HTTP NATIVELY (its own OkHttp threads,
 * which the OS doesn't freeze); Spotify/YT Music resolve the same way. This
 * module gives the resolver that same native path: OkHttp on its own dispatcher
 * threads (via enqueue), which run in the background exactly like ExoPlayer's.
 * The result crosses back to JS via the normal bridge Promise -- already proven
 * to work backgrounded (TrackPlayer/holdPlaybackLocks calls resolve fine there).
 *
 * ANONYMITY: no cookieJar is set, so OkHttp uses CookieJar.NO_COOKIES -- the
 * resolve is genuinely anonymous, independent of the app-wide CookieManager the
 * OAuth login writes to. That's the same guarantee resolver.ts's `credentials:
 * 'omit'` gave the old RN-fetch path (see the long note there), achieved here by
 * simply never attaching a cookie store.
 */
class NativeHttpModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val client: OkHttpClient by lazy {
    OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .callTimeout(45, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        // no .cookieJar(...) -> CookieJar.NO_COOKIES -> genuinely anonymous
        .build()
  }

  override fun getName(): String = "NativeHttp"

  /**
   * @param readBody when false, the response body is NOT read (stream closed
   *   immediately after headers). Used by validateUrl's `Range: bytes=0-` probe,
   *   which only needs the status code -- closing the body cancels the transfer
   *   so we don't pull a whole media file down just to check it's fetchable.
   */
  @ReactMethod
  fun request(
      url: String,
      method: String,
      headers: ReadableMap?,
      body: String?,
      readBody: Boolean,
      promise: Promise,
  ) {
    try {
      val builder = Request.Builder().url(url)
      var contentType: String? = null
      headers?.let { h ->
        val keys = h.keySetIterator()
        while (keys.hasNextKey()) {
          val key = keys.nextKey()
          val value = h.getString(key) ?: continue
          when (key.lowercase()) {
            // Let OkHttp manage these: it does transparent gzip only when it
            // sets Accept-Encoding itself, and computes Content-Length. A
            // caller-supplied Accept-Encoding would make it return raw gzip
            // bytes that .string() can't decode.
            "accept-encoding", "content-length" -> continue
            "content-type" -> contentType = value
          }
          builder.header(key, value)
        }
      }
      val m = method.uppercase()
      val requiresBody = m == "POST" || m == "PUT" || m == "PATCH" || m == "DELETE"
      val reqBody =
          when {
            body != null -> body.toRequestBody(contentType?.toMediaTypeOrNull())
            requiresBody -> ByteArray(0).toRequestBody(null)
            else -> null
          }
      builder.method(m, reqBody)

      // enqueue() runs on OkHttp's own dispatcher threads -- native, not the RN
      // JS/bridge thread, and NOT frozen when the app is backgrounded.
      client.newCall(builder.build()).enqueue(
          object : Callback {
            override fun onFailure(call: Call, e: IOException) {
              promise.reject("network_error", e.message ?: "request failed", e)
            }

            override fun onResponse(call: Call, response: Response) {
              response.use { resp ->
                try {
                  val map = Arguments.createMap()
                  map.putInt("status", resp.code)
                  map.putString("statusText", resp.message)
                  map.putString("url", resp.request.url.toString())
                  map.putString("body", if (readBody) resp.body?.string() ?: "" else "")
                  val hmap = Arguments.createMap()
                  for (name in resp.headers.names()) {
                    hmap.putString(name, resp.headers.values(name).joinToString(", "))
                  }
                  map.putMap("headers", hmap)
                  promise.resolve(map)
                } catch (e: Exception) {
                  promise.reject("read_error", e.message ?: "read failed", e)
                }
              }
            }
          },
      )
    } catch (e: Exception) {
      promise.reject("request_error", e.message ?: "bad request", e)
    }
  }

  @ReactMethod fun addListener(eventName: String) {}

  @ReactMethod fun removeListeners(count: Int) {}
}
