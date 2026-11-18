package com.wellsey001.snippy;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

// Saves a finished video into the phone's gallery, in a "Snippy" album (Movies/Snippy).
@CapacitorPlugin(
    name = "SnippySave",
    permissions = { @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }) }
)
public class SnippySavePlugin extends Plugin {

    @PluginMethod
    public void saveVideo(PluginCall call) {
        // Android 9 and older need permission to write to shared storage.
        if (Build.VERSION.SDK_INT < 29 && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storageCallback");
            return;
        }
        save(call);
    }

    @PermissionCallback
    private void storageCallback(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) save(call);
        else call.reject("Snippy needs permission to save videos to your phone.");
    }

    private void save(PluginCall call) {
        String path = call.getString("path");
        String name = call.getString("name", "Snippy.mp4");
        if (path == null) { call.reject("No file to save"); return; }
        try {
            File file = new File(Uri.parse(path).getPath());
            JSObject ret = new JSObject();
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = getContext().getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.Video.Media.DISPLAY_NAME, name);
                v.put(MediaStore.Video.Media.MIME_TYPE, "video/mp4");
                v.put(MediaStore.Video.Media.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/Snippy");
                v.put(MediaStore.Video.Media.IS_PENDING, 1);
                Uri uri = cr.insert(MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v);
                if (uri == null) { call.reject("The gallery wouldn't take the video"); return; }
                try (InputStream in = new FileInputStream(file); OutputStream out = cr.openOutputStream(uri)) {
                    copy(in, out);
                }
                v.clear();
                v.put(MediaStore.Video.Media.IS_PENDING, 0);
                cr.update(uri, v, null, null);
                ret.put("uri", uri.toString());
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "Snippy");
                if (!dir.exists()) dir.mkdirs();
                File dest = new File(dir, name);
                try (InputStream in = new FileInputStream(file); OutputStream out = new FileOutputStream(dest)) {
                    copy(in, out);
                }
                MediaScannerConnection.scanFile(getContext(), new String[] { dest.getAbsolutePath() }, new String[] { "video/mp4" }, null);
                ret.put("uri", Uri.fromFile(dest).toString());
            }
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Couldn't save the video: " + e.getMessage());
        }
    }

    private static void copy(InputStream in, OutputStream out) throws java.io.IOException {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.flush();
    }
}
