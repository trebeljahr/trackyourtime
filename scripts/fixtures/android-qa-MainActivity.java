package com.ricoslabs.trackyourtime;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.content.Context;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.nio.file.Files;
import java.nio.charset.StandardCharsets;
import java.io.File;
import java.util.Collections;
import org.json.JSONObject;

/** Copied only into the temporary QA project, never the shipping app. */
public class MainActivity extends BridgeActivity {
    private final Handler qaHandler = new Handler(Looper.getMainLooper());
    private String lastId = "";
    private volatile boolean busy = false;
    private long busySince = 0;
    private boolean readOnlyCommand = false;
    @Override public void onCreate(Bundle state) {
        if (!BuildConfig.DEBUG || !getPackageName().endsWith(".emulatorqa")) throw new IllegalStateException("QA build only");
        registerPlugin(QASecureStorage.class);
        super.onCreate(state);
        getBridge().getWebView().addJavascriptInterface(new Object() {
            @JavascriptInterface public void report(String response) {
                try { Files.write(new File(getFilesDir(), "qa-result.json").toPath(), response.getBytes(StandardCharsets.UTF_8)); }
                catch (Exception ignored) {} finally { busy = false; }
            }
        }, "QAResult");
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) throw new IllegalStateException("WebView document-start instrumentation unavailable");
        WebViewCompat.addDocumentStartJavaScript(getBridge().getWebView(),
            "window.__qaErrors=[];addEventListener('error',e=>__qaErrors.push(e.message));addEventListener('unhandledrejection',e=>__qaErrors.push(String(e.reason)));addEventListener('securitypolicyviolation',e=>__qaErrors.push('CSP: '+e.violatedDirective));",
            Collections.singleton("*"));
        getBridge().getWebView().reload();
        qaHandler.post(new Runnable() {
            public void run() { poll(); qaHandler.postDelayed(this, 150); }
        });
    }
    private void poll() {
        // A document replacement can discard a pending JS promise. Only read
        // probes may expire; mutating commands must never be replayed.
        if (busy && (!readOnlyCommand || android.os.SystemClock.elapsedRealtime() - busySince < 5000)) return;
        busy = false;
        try {
            JSONObject command = new JSONObject(new String(Files.readAllBytes(new File(getFilesDir(), "qa-command.json").toPath()), StandardCharsets.UTF_8));
            String id = command.getString("id");
            if (id.equals(lastId)) return;
            Files.deleteIfExists(new File(getFilesDir(), "qa-command.json").toPath());
            lastId = id;
            busy = true;
            busySince = android.os.SystemClock.elapsedRealtime();
            readOnlyCommand = command.getString("script").startsWith("return Boolean(");
            String script = "(async()=>{try{const value=await(async()=>{" + command.getString("script") + "})();QAResult.report(JSON.stringify({id:" + JSONObject.quote(id) + ",value:value??null}));}catch(error){QAResult.report(JSON.stringify({id:" + JSONObject.quote(id) + ",error:String(error)}));}})()";
            getBridge().getWebView().evaluateJavascript(script, null);
        } catch (Exception ignored) { busy = false; }
    }
    @Override public void onDestroy() { qaHandler.removeCallbacksAndMessages(null); super.onDestroy(); }

    @CapacitorPlugin(name="SecureStorage")
    public static class QASecureStorage extends Plugin {
        private android.content.SharedPreferences store() { return getContext().getSharedPreferences("qa-fake-credentials", Context.MODE_PRIVATE); }
        @PluginMethod public void setSynchronizeKeychain(PluginCall call) { call.resolve(); }
        @PluginMethod public void internalGetItem(PluginCall call) {
            String data = store().getString(call.getString("prefixedKey", ""), null);
            JSObject result = new JSObject(); result.put("data", data == null ? JSONObject.NULL : data); call.resolve(result);
        }
        @PluginMethod public void internalSetItem(PluginCall call) { store().edit().putString(call.getString("prefixedKey", ""), call.getString("data")).commit(); call.resolve(); }
        @PluginMethod public void internalRemoveItem(PluginCall call) { store().edit().remove(call.getString("prefixedKey", "")).commit(); JSObject result = new JSObject(); result.put("success", true); call.resolve(result); }
    }
}
