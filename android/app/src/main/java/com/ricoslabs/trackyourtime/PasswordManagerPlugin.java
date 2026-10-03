package com.ricoslabs.trackyourtime;

import android.content.MutableContextWrapper;
import android.os.CancellationSignal;
import androidx.core.content.ContextCompat;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPasswordOption;
import androidx.credentials.PasswordCredential;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Uses the signed app identity, not the bundled WebView's localhost origin. */
@CapacitorPlugin(name = "PasswordManager")
public class PasswordManagerPlugin extends Plugin {
    private CancellationSignal pending;

    @PluginMethod
    public void getPassword(PluginCall call) {
        // Website credentials must never be offered for an arbitrary self-hosted server.
        if (!"https://api.trackyourtime.dev".equals(call.getString("apiOrigin"))) {
            call.reject("Password sharing is unavailable for this server", "UNSUPPORTED_SERVER");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (pending != null) {
                call.reject("A password request is already open", "BUSY");
                return;
            }
            CancellationSignal signal = new CancellationSignal();
            pending = signal;
            GetCredentialRequest request = new GetCredentialRequest.Builder()
                .addCredentialOption(new GetPasswordOption())
                .build();
            try {
                CredentialManager.create(getActivity()).getCredentialAsync(
                    new MutableContextWrapper(getActivity()), request, signal,
                    ContextCompat.getMainExecutor(getActivity()),
                    new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                        @Override
                        public void onResult(GetCredentialResponse response) {
                            if (pending == signal) pending = null;
                            if (signal.isCanceled()) {
                                call.reject("Password request cancelled", "CANCELLED");
                            } else if (response.getCredential() instanceof PasswordCredential) {
                                PasswordCredential credential = (PasswordCredential) response.getCredential();
                                JSObject result = new JSObject();
                                result.put("email", credential.getId());
                                result.put("password", credential.getPassword());
                                call.resolve(result);
                            } else {
                                call.reject("No saved password available", "NO_CREDENTIAL");
                            }
                        }

                        @Override
                        public void onError(GetCredentialException error) {
                            if (pending == signal) pending = null;
                            String code = error instanceof GetCredentialCancellationException ? "CANCELLED"
                                : error instanceof NoCredentialException ? "NO_CREDENTIAL" : "UNAVAILABLE";
                            // Provider errors can contain account details; never forward or log them.
                            call.reject("Password request did not complete", code);
                        }
                    }
                );
            } catch (Exception error) {
                pending = null;
                call.reject("Password manager unavailable", "UNAVAILABLE");
            }
        });
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            cancelPending();
            call.resolve();
        });
    }

    private void cancelPending() {
        if (pending != null) {
            CancellationSignal signal = pending;
            pending = null;
            signal.cancel();
        }
    }

    @Override
    protected void handleOnDestroy() {
        cancelPending();
    }
}
