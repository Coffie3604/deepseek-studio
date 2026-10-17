package com.coffie.deepseekstudio;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.AudioManager;
import android.net.Uri;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.speech.tts.TextToSpeech;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;

/**
 * DeviceBridge - the in-app replacement for Termux:API.
 *
 * The web UI (and therefore the AI agent) talks to Android through
 * window.AndroidDevice.<method>(jsonArgs) instead of shelling out to
 * termux-toast, termux-clipboard-set, etc. That means the APK no longer
 * needs the separate Termux:API app installed.
 *
 * Every method returns a JSON string: {"ok":true,...} or {"ok":false,"error":"..."}.
 */
public class DeviceBridge {

    private final Activity activity;
    private final WebView webView;
    private TextToSpeech tts;

    public DeviceBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
    }

    /* ------------------------- helpers ------------------------- */

    private static String ok(JSONObject o) {
        try {
            o.put("ok", true);
            return o.toString();
        } catch (Exception e) {
            return "{\"ok\":true}";
        }
    }

    private static String err(String message) {
        try {
            return new JSONObject().put("ok", false).put("error", message).toString();
        } catch (Exception e) {
            return "{\"ok\":false,\"error\":\"unknown\"}";
        }
    }

    private static JSONObject parse(String json) {
        if (json == null || json.trim().isEmpty()) return new JSONObject();
        try {
            return new JSONObject(json);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private Context ctx() {
        return activity.getApplicationContext();
    }

    /* ------------------------- notifications ------------------------- */

    @JavascriptInterface
    public String notify(String json) {
        try {
            JSONObject a = parse(json);
            String title = a.optString("title", "DeepSeek Studio");
            String message = a.optString("message", "");
            NotificationManager nm =
                    (NotificationManager) ctx().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return err("no notification service");

            String channelId = "deepseek";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel ch = new NotificationChannel(
                        channelId, "DeepSeek Studio", NotificationManager.IMPORTANCE_HIGH);
                nm.createNotificationChannel(ch);
            }

            Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    ? new Notification.Builder(ctx(), channelId)
                    : new Notification.Builder(ctx());
            b.setSmallIcon(android.R.drawable.stat_notify_chat)
                    .setContentTitle(title)
                    .setContentText(message)
                    .setAutoCancel(true);
            nm.notify((int) (System.currentTimeMillis() % 100000), b.build());
            return ok(new JSONObject().put("via", "native"));
        } catch (Exception e) {
            return err(String.valueOf(e.getMessage()));
        }
    }

    /* ------------------------- clipboard ------------------------- */

    @JavascriptInterface
    public String clipboardGet() {
        try {
            ClipboardManager cm =
                    (ClipboardManager) ctx().getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip()) return ok(new JSONObject().put("text", ""));
            ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0)
                return ok(new JSONObject().put("text", ""));
            CharSequence text = clip.getItemAt(0).coerceToText(ctx());
            return ok(new JSONObject().put("text", text == null ? "" : text.toString()));
        } catch (Exception e) {
            return err(String.valueOf(e.getMessage()));
        }
    }

    @JavascriptInterface
    public String clipboardSet(String json) {
        try {
            String text = parse(json).optString("text", "");
            ClipboardManager cm =
                    (ClipboardManager) ctx().getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) return err("no clipboard service");
            cm.setPrimaryClip(ClipData.newPlainText("DeepSeek Studio", text));
            return ok(new JSONObject().put("length", text.length()));
        } catch (Exception e) {
            return err(String.valueOf(e.getMessage()));
        }
    }

    /* ------------------------- battery ------------------------- */

    @JavascriptInterface
    public String batteryStatus() {
        try {
            Intent battery = activity.registerReceiver(
                    null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery == null) return err("battery unavailable");
            int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            int pct = (level >= 0 && scale > 0) ? (int) (level * 100f / scale) : -1;
            int status = battery.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            int temp = battery.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1);
            return ok(new JSONObject()
                    .put("percentage", pct)
                    .put("temperature", temp > 0 ? temp / 10.0 : -1)
                    .put("plugged", battery.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0)
                    .put("charging", status == BatteryManager.BATTERY_STATUS_CHARGING
                            || status == BatteryManager.BATTERY_STATUS_FULL));
        } catch (Exception e) {
            return err(String.valueOf(e.getMessage()));
        }
    }

    /* ------------------------- torch ------------------------- */

    @JavascriptInterface
    public String torch(String json) {
        try {
            boolean on = parse(json).optBoolean("on", false);
            CameraManager cm = (CameraManager) ctx().getSystemService(Context.CAMERA_SERVICE);
            if (cm == null) return err("no camera service");
            String id = null;
            for (String candidate : cm.getCameraIdList()) {
                Boolean flash = cm.getCameraCharacteristics(candidate)
                        .get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                if (flash != null && flash) { id = candidate; break; }
            }
            if (id == null) return err("no flash unit");
            cm.setTorchMode(id, on);
            return ok(new JSONObject().put("on", on));
        } catch (Exception e) {
            return err(String.valueOf(e.getMessage()));
        }
    }

    /* ------------------------- vibrate ------------------------- */

    @JavascriptInterface
    public String vibrate(String json) {
        try {
            int ms = parse(json).optInt("duration", 300);
            Vibrator v = (Vibrator) ctx().getSystemService(Context.VIBRATOR_SERVICE);
            if (v == null || !v.hasVibrator()) return err("no vibrator");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                v.vibrate(ms);
            }
            return ok(new JSONObject().put("duration", ms));
        } catch (Exception e) {
            return err(String.valueOf(e.getMessage()));
        }
    }

    /* ------------------------- volume ------------------------- */

    @JavascriptInterface
    public String volume(String json) {
        try {
            JSONObject a = parse(json);
            AudioManager am = (AudioManager) ctx().getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return err("no audio service");
            int stream = AudioManager.STREAM_MUSIC;
            String name = a.optString("stream", "music").toLowerCase(Locale.US);
            if (name.contains("ring")) stream = AudioManager.STREAM_RING;
            else if (name.contains("alarm")) stream = AudioManager.STREAM_ALARM;
            else if (name.contains("notif")) stream = AudioManager.STREAM_NOTIFICATION;
            else if (name.contains("call")) stream = AudioManager.STREAM_VOICE_CALL;

            String action = a.optString("action", "get");
            if (a.has("volume")) {
                am.setStreamVolume(stream, a.optInt("volume", 0), 0);
            } else if ("up".equals(action)) {
                am.adjustStreamVolume(stream, AudioManager.ADJUST_RAISE, 0);
            } else if ("down".equals(action)) {
                am.adjustStreamVolume(stream, AudioManager.ADJUST_LOWER, 0);
            }
            return ok(new JSONObject()
                    .put("volume", am.getStreamVolume(stream))
                    .put("max", am.getStreamMaxVolume(stream)));
        } catch (Exception e) {
            return err(String.valueOf(e.getMessage()));
        }
    }

    /* ------------------------- TTS ------------------------- */

    @JavascriptInterface
    public String ttsSpeak(String json) {
        try {
            final String text = parse(json).optString("text", "");
            if (text.isEmpty()) return err("text required");
            if (tts == null) {
                tts = new TextToSpeech(ctx(), status -> { });
            }
            activity.runOnUiThread(() -> {
                if (tts != null) tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "ds");
            });
            return ok(new JSONObject().put("queued", true));
        } catch (Exception e) {
            return err(String.valueOf(e.getMessage()));
        }
    }

    /* ------------------------- open URL / share ------------------------- */

    @JavascriptInterface
    public String openUrl(String json) {
        try {
            String url = parse(json).optString("url", "");
            if (!url.startsWith("http://") && !url.startsWith("https://"))
                return err("invalid url");
            activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            return ok(new JSONObject().put("url", url));
        } catch (Exception e) {
            return err(String.valueOf(e.getMessage()));
        }
    }

    @JavascriptInterface
    public String share(String json) {
        try {
            JSONObject a = parse(json);
            String text = a.optString("text", "");
            String title = a.optString("title", "Share");
            Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain");
            send.putExtra(Intent.EXTRA_TEXT, text);
            activity.startActivity(Intent.createChooser(send, title));
            return ok(new JSONObject().put("shared", true));
        } catch (Exception e) {
            return err(String.valueOf(e.getMessage()));
        }
    }

    /* ------------------------- wifi ------------------------- */

    @JavascriptInterface
    public String wifiInfo() {
        try {
            WifiManager wm = (WifiManager) ctx().getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wm == null) return err("no wifi service");
            WifiInfo info = wm.getConnectionInfo();
            if (info == null) return err("not connected");
            return ok(new JSONObject()
                    .put("ssid", info.getSSID())
                    .put("bssid", info.getBSSID())
                    .put("ip", intToIp(info.getIpAddress()))
                    .put("rssi", info.getRssi()));
        } catch (Exception e) {
            return err(String.valueOf(e.getMessage()));
        }
    }

    private static String intToIp(int ip) {
        return (ip & 0xff) + "." + ((ip >> 8) & 0xff) + "."
                + ((ip >> 16) & 0xff) + "." + ((ip >> 24) & 0xff);
    }

    /* ------------------------- storage ------------------------- */

    @JavascriptInterface
    public String storageInfo() {
        try {
            StatFs fs = new StatFs(Environment.getDataDirectory().getPath());
            long block = fs.getBlockSizeLong();
            return ok(new JSONObject()
                    .put("total", fs.getBlockCountLong() * block)
                    .put("free", fs.getAvailableBlocksLong() * block));
        } catch (Exception e) {
            return err(String.valueOf(e.getMessage()));
        }
    }

    /* ------------------------- capability probe ------------------------- */

    /** Lets the UI know the native bridge is present (so it can skip Termux:API). */
    @JavascriptInterface
    public String capabilities() {
        try {
            JSONArray list = new JSONArray();
            for (String c : new String[]{"notify", "clipboard", "battery", "torch", "vibrate",
                    "volume", "tts", "openUrl", "share", "wifi", "storage"}) {
                list.put(c);
            }
            return ok(new JSONObject().put("native", true).put("methods", list));
        } catch (Exception e) {
            return err(String.valueOf(e.getMessage()));
        }
    }

    /** Called from the activity's onDestroy to release the TTS engine. */
    public void release() {
        if (tts != null) {
            try { tts.stop(); } catch (Exception ignored) { }
            tts = null;
        }
    }
}
