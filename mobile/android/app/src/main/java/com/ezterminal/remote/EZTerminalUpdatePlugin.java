package com.ezterminal.remote;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Downloads a single GitHub Release APK without routing its bytes through the
 * WebView. The APK remains private until digest, identity, version, and signer
 * checks all pass; only then is it published to MediaStore Downloads.
 */
@CapacitorPlugin(name = "EZTerminalUpdate")
public class EZTerminalUpdatePlugin extends Plugin {

    static final int MAX_UPDATE_BYTES = 100 * 1_048_576;
    static final int MAX_REDIRECTS = 5;
    static final String RELATIVE_DOWNLOAD_PATH = Environment.DIRECTORY_DOWNLOADS + "/EZTerminal";
    private static final int BUFFER_BYTES = 64 * 1_024;
    private static final long PROGRESS_INTERVAL_MS = 100;
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private static final String OWNER = "dlwlgus9125";
    private static final String REPOSITORY = "EZTerminal";
    private static final String GITHUB_HOST = "github.com";
    private static final Set<String> RELEASE_ASSET_HOSTS = new HashSet<>(Arrays.asList(
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com"
    ));

    private final Object transferLock = new Object();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Set<String> verifiedUris = new HashSet<>();
    private ActiveTransfer activeTransfer;
    private boolean destroyed;

    private static final class UpdateFailure extends Exception {
        final String code;

        UpdateFailure(String code, String message) {
            super(message);
            this.code = code;
        }

        UpdateFailure(String code, String message, Throwable cause) {
            super(message, cause);
            this.code = code;
        }
    }

    private static final class ActiveTransfer {
        volatile boolean cancelled;
        volatile HttpURLConnection connection;
        File cacheFile;
        ContentResolver resolver;
        Uri pendingUri;
    }

    static boolean isValidInitialDownloadUrl(
        String rawUrl,
        String name,
        String versionName,
        int versionCode
    ) {
        if (
            rawUrl == null
            || name == null
            || versionName == null
            || !versionName.matches("\\d+\\.\\d+\\.\\d+")
            || versionCode < 1
            || !name.equals(
                "EZTerminal-Android-" + versionName + "-vc" + versionCode + ".apk"
            )
        ) return false;
        try {
            URI uri = new URI(rawUrl);
            String expectedPath = "/" + OWNER + "/" + REPOSITORY + "/releases/download/v"
                + versionName + "/" + name;
            return (
                "https".equals(uri.getScheme())
                && GITHUB_HOST.equals(uri.getHost())
                && uri.getPort() == -1
                && uri.getUserInfo() == null
                && uri.getQuery() == null
                && uri.getFragment() == null
                && expectedPath.equals(uri.getPath())
            );
        } catch (Exception ignored) {
            return false;
        }
    }

    static boolean isAllowedRedirectUrl(String rawUrl) {
        try {
            URI uri = new URI(rawUrl);
            if (
                !"https".equals(uri.getScheme())
                || uri.getPort() != -1
                || uri.getUserInfo() != null
                || uri.getFragment() != null
            ) return false;
            if (RELEASE_ASSET_HOSTS.contains(uri.getHost())) return true;
            String releasePrefix = "/" + OWNER + "/" + REPOSITORY + "/releases/download/";
            return GITHUB_HOST.equals(uri.getHost()) && uri.getPath().startsWith(releasePrefix);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean validSha256(String value) {
        return value != null && value.matches("(?i)^[0-9a-f]{64}$");
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }

    private static void deleteQuietly(File file) {
        if (file == null) return;
        try {
            if (file.exists()) file.delete();
        } catch (RuntimeException ignored) {}
    }

    private static void deleteQuietly(ContentResolver resolver, Uri uri) {
        if (resolver == null || uri == null) return;
        try {
            resolver.delete(uri, null, null);
        } catch (RuntimeException ignored) {}
    }

    private static void closeQuietly(AutoCloseable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (Exception ignored) {}
    }

    private static void assertNotCancelled(ActiveTransfer transfer) throws UpdateFailure {
        if (transfer.cancelled || Thread.currentThread().isInterrupted()) {
            throw new UpdateFailure("CANCELLED", "Update download was cancelled");
        }
    }

    private void notifyProgress(int receivedBytes, int totalBytes) {
        JSObject progress = new JSObject();
        progress.put("receivedBytes", receivedBytes);
        progress.put("totalBytes", totalBytes);
        notifyListeners("updateDownloadProgress", progress);
    }

    private File downloadToPrivateCache(
        ActiveTransfer transfer,
        String rawUrl,
        int expectedBytes,
        String expectedSha256
    ) throws UpdateFailure {
        File updateDirectory = new File(getContext().getCacheDir(), "updates");
        if (!updateDirectory.isDirectory() && !updateDirectory.mkdirs()) {
            throw new UpdateFailure("STORAGE", "Unable to create the update cache");
        }
        File cacheFile = new File(updateDirectory, UUID.randomUUID() + ".apk.part");
        transfer.cacheFile = cacheFile;

        URI current;
        try {
            current = new URI(rawUrl);
        } catch (Exception error) {
            throw new UpdateFailure("INVALID_URL", "Invalid update URL", error);
        }

        HttpURLConnection connection = null;
        try {
            for (int redirectCount = 0; ; redirectCount++) {
                assertNotCancelled(transfer);
                try {
                    connection = (HttpURLConnection) new URL(current.toString()).openConnection();
                    transfer.connection = connection;
                    connection.setInstanceFollowRedirects(false);
                    connection.setConnectTimeout(15_000);
                    connection.setReadTimeout(30_000);
                    connection.setRequestProperty("Accept", "application/octet-stream");
                    connection.setRequestProperty("Accept-Encoding", "identity");
                    connection.setRequestProperty("User-Agent", "EZTerminal-Android-Updater");
                    int status = connection.getResponseCode();
                    if (status >= 300 && status < 400) {
                        String location = connection.getHeaderField("Location");
                        if (location == null || redirectCount >= MAX_REDIRECTS) {
                            throw new UpdateFailure("INVALID_URL", "Invalid update redirect");
                        }
                        URI redirected = current.resolve(location);
                        if (!isAllowedRedirectUrl(redirected.toString())) {
                            throw new UpdateFailure("INVALID_URL", "Blocked update redirect");
                        }
                        connection.disconnect();
                        connection = null;
                        current = redirected;
                        continue;
                    }
                    if (status != HttpURLConnection.HTTP_OK) {
                        throw new UpdateFailure("HTTP", "GitHub returned HTTP " + status);
                    }
                    break;
                } catch (UpdateFailure error) {
                    throw error;
                } catch (java.net.SocketTimeoutException error) {
                    throw new UpdateFailure("TIMEOUT", "Update download timed out", error);
                } catch (Exception error) {
                    throw new UpdateFailure("NETWORK", "Update download failed", error);
                }
            }

            long contentLength = connection.getContentLengthLong();
            if (contentLength > MAX_UPDATE_BYTES || (
                contentLength >= 0 && contentLength != expectedBytes
            )) {
                throw new UpdateFailure("INTEGRITY_MISMATCH", "Update size does not match");
            }

            MessageDigest digest;
            try {
                digest = MessageDigest.getInstance("SHA-256");
            } catch (Exception error) {
                throw new UpdateFailure("INTEGRITY_MISMATCH", "SHA-256 is unavailable", error);
            }

            int receivedBytes = 0;
            long lastProgressAt = 0;
            try (
                InputStream input = connection.getInputStream();
                OutputStream output = new FileOutputStream(cacheFile)
            ) {
                byte[] buffer = new byte[BUFFER_BYTES];
                for (;;) {
                    assertNotCancelled(transfer);
                    int read = input.read(buffer);
                    if (read < 0) break;
                    if (read == 0) continue;
                    receivedBytes += read;
                    if (receivedBytes > expectedBytes || receivedBytes > MAX_UPDATE_BYTES) {
                        throw new UpdateFailure("INTEGRITY_MISMATCH", "Update exceeds its declared size");
                    }
                    digest.update(buffer, 0, read);
                    output.write(buffer, 0, read);
                    long now = android.os.SystemClock.elapsedRealtime();
                    if (
                        now - lastProgressAt >= PROGRESS_INTERVAL_MS
                        || receivedBytes == expectedBytes
                    ) {
                        lastProgressAt = now;
                        notifyProgress(receivedBytes, expectedBytes);
                    }
                }
                output.flush();
            } catch (UpdateFailure error) {
                throw error;
            } catch (java.net.SocketTimeoutException error) {
                throw new UpdateFailure("TIMEOUT", "Update download timed out", error);
            } catch (Exception error) {
                throw new UpdateFailure("NETWORK", "Update download failed", error);
            }
            assertNotCancelled(transfer);
            if (
                receivedBytes != expectedBytes
                || !MessageDigest.isEqual(
                    hex(digest.digest()).getBytes(java.nio.charset.StandardCharsets.US_ASCII),
                    expectedSha256.toLowerCase(Locale.ROOT)
                        .getBytes(java.nio.charset.StandardCharsets.US_ASCII)
                )
            ) {
                throw new UpdateFailure("INTEGRITY_MISMATCH", "Update digest does not match");
            }
            return cacheFile;
        } finally {
            transfer.connection = null;
            if (connection != null) connection.disconnect();
        }
    }

    private static Set<String> signingDigests(PackageInfo packageInfo) throws UpdateFailure {
        if (packageInfo == null || packageInfo.signingInfo == null) {
            throw new UpdateFailure("SIGNER_MISMATCH", "APK signer is unavailable");
        }
        Signature[] signatures = packageInfo.signingInfo.getApkContentsSigners();
        if (signatures == null || signatures.length == 0) {
            throw new UpdateFailure("SIGNER_MISMATCH", "APK signer is unavailable");
        }
        Set<String> result = new HashSet<>();
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            for (Signature signature : signatures) {
                result.add(hex(digest.digest(signature.toByteArray())));
                digest.reset();
            }
        } catch (Exception error) {
            throw new UpdateFailure("SIGNER_MISMATCH", "Unable to inspect APK signer", error);
        }
        return result;
    }

    private void verifyApk(
        File apk,
        String expectedVersionName,
        int expectedVersionCode
    ) throws UpdateFailure {
        PackageManager packageManager = getContext().getPackageManager();
        PackageInfo archive = packageManager.getPackageArchiveInfo(
            apk.getAbsolutePath(),
            PackageManager.GET_SIGNING_CERTIFICATES
        );
        if (
            archive == null
            || !getContext().getPackageName().equals(archive.packageName)
            || !expectedVersionName.equals(archive.versionName)
            || archive.getLongVersionCode() != expectedVersionCode
        ) {
            throw new UpdateFailure("PACKAGE_MISMATCH", "APK identity or version does not match");
        }
        try {
            PackageInfo installed = packageManager.getPackageInfo(
                getContext().getPackageName(),
                PackageManager.GET_SIGNING_CERTIFICATES
            );
            if (!signingDigests(installed).equals(signingDigests(archive))) {
                throw new UpdateFailure("SIGNER_MISMATCH", "APK signer does not match the installed app");
            }
        } catch (PackageManager.NameNotFoundException error) {
            throw new UpdateFailure("SIGNER_MISMATCH", "Installed app signer is unavailable", error);
        }
    }

    private static boolean displayNameExists(
        ContentResolver resolver,
        Uri collection,
        String displayName
    ) {
        try (Cursor cursor = resolver.query(
            collection,
            new String[] { MediaStore.MediaColumns._ID },
            MediaStore.MediaColumns.RELATIVE_PATH + "=? AND "
                + MediaStore.MediaColumns.DISPLAY_NAME + "=?",
            new String[] { RELATIVE_DOWNLOAD_PATH + "/", displayName },
            null
        )) {
            return cursor != null && cursor.moveToFirst();
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static String collisionName(String requested, int collisionIndex) {
        if (collisionIndex == 0) return requested;
        int dot = requested.lastIndexOf('.');
        return requested.substring(0, dot) + " (" + collisionIndex + ")" + requested.substring(dot);
    }

    private MobileUpdateDownloadResult publishToDownloads(
        ActiveTransfer transfer,
        File source,
        String requestedName
    ) throws UpdateFailure {
        ContentResolver resolver = getContext().getContentResolver();
        transfer.resolver = resolver;
        Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        Uri uri = null;
        String displayName = null;
        for (int collisionIndex = 0; collisionIndex < 1_000; collisionIndex++) {
            displayName = collisionName(requestedName, collisionIndex);
            if (displayNameExists(resolver, collection, displayName)) continue;
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, displayName);
            values.put(MediaStore.MediaColumns.MIME_TYPE, APK_MIME);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, RELATIVE_DOWNLOAD_PATH);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            uri = resolver.insert(collection, values);
            if (uri != null) break;
        }
        if (uri == null || displayName == null) {
            throw new UpdateFailure("STORAGE", "Unable to allocate a Downloads entry");
        }
        transfer.pendingUri = uri;

        try (
            InputStream input = new FileInputStream(source);
            OutputStream output = resolver.openOutputStream(uri, "w")
        ) {
            if (output == null) throw new UpdateFailure("STORAGE", "Downloads output is unavailable");
            byte[] buffer = new byte[BUFFER_BYTES];
            for (;;) {
                assertNotCancelled(transfer);
                int read = input.read(buffer);
                if (read < 0) break;
                if (read > 0) output.write(buffer, 0, read);
            }
            output.flush();
        } catch (UpdateFailure error) {
            throw error;
        } catch (Exception error) {
            throw new UpdateFailure("STORAGE", "Unable to publish update to Downloads", error);
        }

        ContentValues complete = new ContentValues();
        complete.put(MediaStore.MediaColumns.IS_PENDING, 0);
        if (resolver.update(uri, complete, null, null) != 1) {
            throw new UpdateFailure("STORAGE", "Unable to finish the Downloads entry");
        }
        return new MobileUpdateDownloadResult(displayName, uri.toString());
    }

    private static final class MobileUpdateDownloadResult {
        final String name;
        final String uri;

        MobileUpdateDownloadResult(String name, String uri) {
            this.name = name;
            this.uri = uri;
        }
    }

    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        String rawUrl = call.getString("url");
        String name = call.getString("name");
        Integer expectedBytes = call.getInt("expectedBytes");
        String expectedSha256 = call.getString("expectedSha256");
        String versionName = call.getString("versionName");
        Integer versionCode = call.getInt("versionCode");
        if (
            expectedBytes == null
            || expectedBytes < 1
            || expectedBytes > MAX_UPDATE_BYTES
            || versionCode == null
            || !validSha256(expectedSha256)
            || !isValidInitialDownloadUrl(rawUrl, name, versionName, versionCode)
        ) {
            call.reject("Invalid update release descriptor", "INVALID_RELEASE");
            return;
        }

        ActiveTransfer transfer = new ActiveTransfer();
        synchronized (transferLock) {
            if (destroyed) {
                call.reject("Update plugin is shutting down", "PLUGIN_DESTROYED");
                return;
            }
            if (activeTransfer != null) {
                call.reject("Another update download is active", "DOWNLOAD_BUSY");
                return;
            }
            activeTransfer = transfer;
        }

        executor.execute(() -> {
            try {
                File cache = downloadToPrivateCache(
                    transfer,
                    rawUrl,
                    expectedBytes,
                    expectedSha256
                );
                verifyApk(cache, versionName, versionCode);
                assertNotCancelled(transfer);
                MobileUpdateDownloadResult downloaded = publishToDownloads(transfer, cache, name);
                synchronized (transferLock) {
                    if (destroyed) throw new UpdateFailure("CANCELLED", "Plugin was destroyed");
                    verifiedUris.add(downloaded.uri);
                    while (verifiedUris.size() > 4) {
                        verifiedUris.remove(verifiedUris.iterator().next());
                    }
                    transfer.pendingUri = null;
                    if (activeTransfer == transfer) activeTransfer = null;
                }
                deleteQuietly(cache);
                transfer.cacheFile = null;
                JSObject result = new JSObject();
                result.put("name", downloaded.name);
                result.put("uri", downloaded.uri);
                call.resolve(result);
            } catch (UpdateFailure error) {
                deleteQuietly(transfer.resolver, transfer.pendingUri);
                deleteQuietly(transfer.cacheFile);
                synchronized (transferLock) {
                    if (activeTransfer == transfer) activeTransfer = null;
                }
                call.reject(error.getMessage(), error.code, error);
            } catch (Exception error) {
                deleteQuietly(transfer.resolver, transfer.pendingUri);
                deleteQuietly(transfer.cacheFile);
                synchronized (transferLock) {
                    if (activeTransfer == transfer) activeTransfer = null;
                }
                call.reject("Update download failed", "NETWORK", error);
            }
        });
    }

    @PluginMethod
    public void cancelUpdateDownload(PluginCall call) {
        synchronized (transferLock) {
            if (activeTransfer != null) {
                activeTransfer.cancelled = true;
                HttpURLConnection connection = activeTransfer.connection;
                if (connection != null) connection.disconnect();
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void openDownloadedUpdate(PluginCall call) {
        String rawUri = call.getString("uri");
        if (rawUri == null) {
            call.reject("Downloaded update URI is missing", "OPEN_FAILED");
            return;
        }
        synchronized (transferLock) {
            if (!verifiedUris.contains(rawUri)) {
                call.reject("Downloaded update URI is not verified", "OPEN_FAILED");
                return;
            }
        }
        Uri uri;
        try {
            uri = Uri.parse(rawUri);
            if (!ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
                throw new IllegalArgumentException("URI is not a content URI");
            }
            InputStream probe = getContext().getContentResolver().openInputStream(uri);
            if (probe == null) throw new IllegalStateException("Downloaded APK is unavailable");
            closeQuietly(probe);
        } catch (Exception error) {
            call.reject("Downloaded APK is unavailable", "OPEN_FAILED", error);
            return;
        }

        try {
            if (!getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent permissionIntent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName())
                );
                permissionIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(permissionIntent);
                JSObject result = new JSObject();
                result.put("status", "permission-required");
                call.resolve(result);
                return;
            }
            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setDataAndType(uri, APK_MIME);
            installIntent.setClipData(ClipData.newRawUri("EZTerminal update", uri));
            installIntent.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
            getContext().startActivity(installIntent);
            JSObject result = new JSObject();
            result.put("status", "opened");
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Unable to open the APK installer", "OPEN_FAILED", error);
        }
    }

    @Override
    protected void handleOnDestroy() {
        ActiveTransfer transfer;
        synchronized (transferLock) {
            destroyed = true;
            transfer = activeTransfer;
            activeTransfer = null;
            verifiedUris.clear();
            if (transfer != null) {
                transfer.cancelled = true;
                if (transfer.connection != null) transfer.connection.disconnect();
            }
        }
        if (transfer != null) {
            deleteQuietly(transfer.resolver, transfer.pendingUri);
            deleteQuietly(transfer.cacheFile);
        }
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
