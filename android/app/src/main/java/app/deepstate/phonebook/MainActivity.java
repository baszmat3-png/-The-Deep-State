package app.deepstate.phonebook;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** غلاف بسيط: يفتح موقع دليل الأرقام داخل WebView مع دعم الاتصال والتنزيل ورفع الملفات. */
public class MainActivity extends Activity {
    private static final int REQ_FILE = 11, REQ_STORAGE = 12;

    private WebView web;
    private ProgressBar bar;
    private ValueCallback<Uri[]> chooser;
    private String home, host;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        home = getString(R.string.app_url);
        host = Uri.parse(home).getHost();

        FrameLayout root = new FrameLayout(this);
        web = new WebView(this);
        bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        int h = (int) (3 * getResources().getDisplayMetrics().density);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        root.addView(bar, new FrameLayout.LayoutParams(-1, h));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setBuiltInZoomControls(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        web.addJavascriptInterface(new Bridge(), "AndroidApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return external(r.getUrl());
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) showOffline();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                bar.setProgress(p);
                bar.setVisibility(p < 100 ? View.VISIBLE : View.GONE);
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (chooser != null) chooser.onReceiveValue(null);
                chooser = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(i, "اختر ملفًا"), REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    chooser.onReceiveValue(null);
                    chooser = null;
                    return false;
                }
                return true;
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(home);
    }

    /** true = تعامل التطبيق مع الرابط بنفسه (اتصال، واتساب، رابط خارجي، إعادة المحاولة). */
    private boolean external(Uri u) {
        String sc = u.getScheme() == null ? "" : u.getScheme();
        if (sc.equals("app")) {
            web.loadUrl(home);
            return true;
        }
        if (sc.equals("about") || sc.equals("javascript") || sc.equals("data") || sc.equals("blob")) return false;
        if ((sc.equals("https") || sc.equals("http")) && host.equalsIgnoreCase(u.getHost())) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "لا يوجد تطبيق لفتح هذا الرابط", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    private void showOffline() {
        String html = "<html dir='rtl'><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
                + "<body style='font-family:sans-serif;text-align:center;padding:48px 20px;background:#f1f5f9;color:#0f172a'>"
                + "<h2>تعذّر الاتصال</h2><p>تأكد من الإنترنت. الخادم المجاني قد يحتاج حتى دقيقة ليستيقظ.</p>"
                + "<a href='app://retry' style='display:inline-block;margin-top:20px;padding:14px 28px;background:#0d9488;"
                + "color:#fff;border-radius:14px;text-decoration:none;font-weight:bold'>إعادة المحاولة</a></body></html>";
        web.loadDataWithBaseURL(home, html, "text/html", "UTF-8", null);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE && chooser != null) {
            chooser.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
            chooser = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public void onBackPressed() {
        // أغلق النافذة المفتوحة في الموقع أولًا، ثم ارجع، ثم أخفِ التطبيق
        web.evaluateJavascript("(function(){try{var o=document.getElementById('ov');if(o&&o.classList.contains('on')){closeSh();return 1}}catch(e){}return 0})()", v -> {
            if ("1".equals(v)) return;
            if (web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    /** يستدعيها الموقع (دالة dl) لحفظ ملفات التصدير في مجلد التنزيلات. */
    private class Bridge {
        @JavascriptInterface
        public void save(String name, String mime, String text) {
            String safe = (name == null ? "" : name).replaceAll("[\\\\/:*?\"<>|]", "_").trim();
            if (safe.isEmpty()) safe = "file.txt";
            final String fn = safe;
            if (Build.VERSION.SDK_INT < 29 && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                runOnUiThread(() -> {
                    requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
                    Toast.makeText(MainActivity.this, "اسمح بالتخزين ثم أعد التصدير", Toast.LENGTH_LONG).show();
                });
                return;
            }
            try {
                byte[] data = (text == null ? "" : text).getBytes(StandardCharsets.UTF_8);
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, fn);
                    v.put(MediaStore.Downloads.MIME_TYPE, mime == null || mime.isEmpty() ? "application/octet-stream" : mime.split(";")[0]);
                    v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri u = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (u == null) throw new IOException("insert failed");
                    try (OutputStream o = getContentResolver().openOutputStream(u)) {
                        o.write(data);
                    }
                } else {
                    File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    dir.mkdirs();
                    try (FileOutputStream o = new FileOutputStream(new File(dir, fn))) {
                        o.write(data);
                    }
                }
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "تم الحفظ في مجلد التنزيلات: " + fn, Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "تعذّر حفظ الملف", Toast.LENGTH_LONG).show());
            }
        }
    }
}
