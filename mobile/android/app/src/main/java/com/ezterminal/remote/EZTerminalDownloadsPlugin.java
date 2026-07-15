package com.ezterminal.remote;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;

/** Writes user-requested downloads through MediaStore instead of a raw shared
 * storage path. API 29+ can create the public Downloads collection without
 * broad storage permission, including on a fresh device where no directory
 * has been materialized yet. */
@CapacitorPlugin(name = "EZTerminalDownloads")
public class EZTerminalDownloadsPlugin extends Plugin {

    static final String RELATIVE_DOWNLOAD_PATH = Environment.DIRECTORY_DOWNLOADS + "/EZTerminal";
    static final int MAX_DOWNLOAD_BYTES = 50 * 1_048_576;
    static final int MAX_CHUNK_BYTES = 256 * 1_024;
    private static final int MAX_DISPLAY_NAME_BYTES = 240;
    private static final int MAX_COLLISION_ATTEMPTS = 1000;
    private static final int MAX_ENCODED_CHUNK_CHARS = ((MAX_CHUNK_BYTES + 2) / 3) * 4;

    private final Object transferLock = new Object();
    private ActiveDownload activeDownload;
    private boolean destroyed;

    private static int utf8Length(String value) {
        return value.getBytes(StandardCharsets.UTF_8).length;
    }

    private static String truncateUtf8(String value, int maximumBytes) {
        StringBuilder result = new StringBuilder();
        int usedBytes = 0;
        for (int offset = 0; offset < value.length();) {
            int codePoint = value.codePointAt(offset);
            String character = new String(Character.toChars(codePoint));
            int characterBytes = utf8Length(character);
            if (usedBytes + characterBytes > maximumBytes) break;
            result.append(character);
            usedBytes += characterBytes;
            offset += Character.charCount(codePoint);
        }
        return result.toString();
    }

    static String safeDisplayName(String requested) {
        if (requested == null || requested.isEmpty() || utf8Length(requested) > MAX_DISPLAY_NAME_BYTES) return null;
        if (requested.indexOf('\0') >= 0 || requested.equals(".") || requested.equals("..")) return null;
        if (requested.indexOf('/') >= 0 || requested.indexOf('\\') >= 0) return null;
        for (int offset = 0; offset < requested.length();) {
            int codePoint = requested.codePointAt(offset);
            if (Character.isISOControl(codePoint)) return null;
            offset += Character.charCount(codePoint);
        }
        return new File(requested).getName().equals(requested) ? requested : null;
    }

    static String collisionDisplayName(String requested, int collisionIndex) {
        if (collisionIndex <= 0) return requested;
        String suffix = " (" + collisionIndex + ")";
        int dot = requested.lastIndexOf('.');
        String stem = requested;
        String extension = "";
        if (dot > 0 && dot < requested.length() - 1) {
            String candidateExtension = requested.substring(dot);
            // Preserve normal extensions, but treat an unusually long suffix
            // as part of the stem so the collision suffix always remains.
            if (utf8Length(candidateExtension) <= 32) {
                stem = requested.substring(0, dot);
                extension = candidateExtension;
            }
        }
        int remainingStemBytes = MAX_DISPLAY_NAME_BYTES - utf8Length(suffix) - utf8Length(extension);
        String fittedStem = truncateUtf8(stem, Math.max(1, remainingStemBytes));
        return fittedStem + suffix + extension;
    }

    private static String mimeTypeFor(String name) {
        int dot = name.lastIndexOf('.');
        if (dot <= 0 || dot == name.length() - 1) return "application/octet-stream";
        String extension = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        return mime == null ? "application/octet-stream" : mime;
    }

    private static String displayNameFor(ContentResolver resolver, Uri uri, String fallback) {
        try (Cursor cursor = resolver.query(
            uri,
            new String[] { MediaStore.MediaColumns.DISPLAY_NAME },
            null,
            null,
            null
        )) {
            if (cursor != null && cursor.moveToFirst()) {
                int column = cursor.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME);
                if (column >= 0) {
                    String value = cursor.getString(column);
                    if (value != null && !value.isEmpty()) return value;
                }
            }
        } catch (RuntimeException ignored) {
            // The inserted URI remains authoritative even if metadata lookup
            // is unavailable on an OEM provider.
        }
        return fallback;
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
            // Some OEM providers restrict collection queries. In that case
            // insertion remains authoritative and a null result advances to
            // the next collision candidate.
            return false;
        }
    }

    private static PendingDownload createPendingDownload(
        ContentResolver resolver,
        String requestedName
    ) {
        Uri collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
        for (int collisionIndex = 0; collisionIndex < MAX_COLLISION_ATTEMPTS; collisionIndex++) {
            String candidateName = collisionDisplayName(requestedName, collisionIndex);
            if (displayNameExists(resolver, collection, candidateName)) continue;

            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, candidateName);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mimeTypeFor(candidateName));
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, RELATIVE_DOWNLOAD_PATH);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = resolver.insert(collection, values);
            if (uri != null) return new PendingDownload(uri, candidateName);
        }
        throw new IllegalStateException("MediaStore could not allocate a unique download name");
    }

    private static final class PendingDownload {
        final Uri uri;
        final String displayName;

        PendingDownload(Uri uri, String displayName) {
            this.uri = uri;
            this.displayName = displayName;
        }
    }

    private static final class ActiveDownload {
        final ContentResolver resolver;
        final String transferId;
        final Uri uri;
        final String displayName;
        final int expectedBytes;
        OutputStream stream;
        int receivedBytes;

        ActiveDownload(
            ContentResolver resolver,
            String transferId,
            Uri uri,
            String displayName,
            int expectedBytes,
            OutputStream stream
        ) {
            this.resolver = resolver;
            this.transferId = transferId;
            this.uri = uri;
            this.displayName = displayName;
            this.expectedBytes = expectedBytes;
            this.stream = stream;
        }
    }

    private static void closeQuietly(OutputStream stream) {
        if (stream == null) return;
        try {
            stream.close();
        } catch (Exception ignored) {}
    }

    private static void deleteQuietly(ContentResolver resolver, Uri uri) {
        if (resolver == null || uri == null) return;
        try {
            resolver.delete(uri, null, null);
        } catch (RuntimeException ignored) {}
    }

    /** Must be called while holding {@link #transferLock}. */
    private void discardActiveDownloadLocked() {
        if (activeDownload == null) return;
        closeQuietly(activeDownload.stream);
        activeDownload.stream = null;
        deleteQuietly(activeDownload.resolver, activeDownload.uri);
        activeDownload = null;
    }

    private void discardFailedBegin(ContentResolver resolver, Uri uri, OutputStream stream) {
        synchronized (transferLock) {
            if (activeDownload != null && activeDownload.uri.equals(uri)) {
                discardActiveDownloadLocked();
                return;
            }
        }
        closeQuietly(stream);
        deleteQuietly(resolver, uri);
    }

    @PluginMethod
    public void beginFile(PluginCall call) {
        String name = safeDisplayName(call.getString("name"));
        Integer expectedBytes = call.getInt("expectedBytes");
        if (name == null) {
            call.reject("Invalid download filename", "INVALID_FILENAME");
            return;
        }
        if (expectedBytes == null || expectedBytes < 0 || expectedBytes > MAX_DOWNLOAD_BYTES) {
            call.reject("Invalid download size", "INVALID_SIZE");
            return;
        }

        ContentResolver resolver = null;
        Uri uri = null;
        OutputStream stream = null;
        try {
            JSObject result = new JSObject();
            synchronized (transferLock) {
                if (destroyed) {
                    call.reject("Download storage is shutting down", "PLUGIN_DESTROYED");
                    return;
                }
                if (activeDownload != null) {
                    call.reject("Another download is already being saved", "DOWNLOAD_BUSY");
                    return;
                }
                resolver = getContext().getContentResolver();
                PendingDownload pending = createPendingDownload(resolver, name);
                uri = pending.uri;
                stream = resolver.openOutputStream(uri, "w");
                if (stream == null) throw new IllegalStateException("MediaStore returned no output stream");
                String transferId = UUID.randomUUID().toString();
                activeDownload = new ActiveDownload(
                    resolver,
                    transferId,
                    uri,
                    pending.displayName,
                    expectedBytes,
                    stream
                );
                result.put("transferId", transferId);
            }
            call.resolve(result);
        } catch (Exception error) {
            discardFailedBegin(resolver, uri, stream);
            call.reject("Unable to begin download save", "DOWNLOAD_SAVE_FAILED", error);
        } catch (OutOfMemoryError error) {
            discardFailedBegin(resolver, uri, stream);
            call.reject("Unable to begin download save", "DOWNLOAD_SAVE_FAILED");
        }
    }

    @PluginMethod
    public void writeChunk(PluginCall call) {
        String transferId = call.getString("transferId");
        String data = call.getString("data");
        if (transferId == null || transferId.isEmpty()) {
            call.reject("Download transfer id is missing", "UNKNOWN_TRANSFER");
            return;
        }

        synchronized (transferLock) {
            if (activeDownload == null || !activeDownload.transferId.equals(transferId)) {
                call.reject("Unknown download transfer", "UNKNOWN_TRANSFER");
                return;
            }
            if (data == null || data.isEmpty()) {
                discardActiveDownloadLocked();
                call.reject("Download chunk is missing", "NO_DATA");
                return;
            }
            if (data.length() > MAX_ENCODED_CHUNK_CHARS) {
                discardActiveDownloadLocked();
                call.reject("Download chunk exceeds the bridge limit", "CHUNK_TOO_LARGE");
                return;
            }

            try {
                byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
                if (bytes.length == 0 || bytes.length > MAX_CHUNK_BYTES) {
                    throw new IllegalArgumentException("Decoded download chunk has an invalid size");
                }
                if (activeDownload.receivedBytes + bytes.length > activeDownload.expectedBytes) {
                    throw new IllegalArgumentException("Download exceeds its declared size");
                }
                activeDownload.stream.write(bytes);
                activeDownload.receivedBytes += bytes.length;

                JSObject result = new JSObject();
                result.put("receivedBytes", activeDownload.receivedBytes);
                call.resolve(result);
            } catch (IllegalArgumentException error) {
                discardActiveDownloadLocked();
                call.reject("Invalid download chunk", "INVALID_CHUNK", error);
            } catch (Exception error) {
                discardActiveDownloadLocked();
                call.reject("Unable to write download chunk", "DOWNLOAD_SAVE_FAILED", error);
            } catch (OutOfMemoryError error) {
                discardActiveDownloadLocked();
                call.reject("Unable to write download chunk", "DOWNLOAD_SAVE_FAILED");
            }
        }
    }

    @PluginMethod
    public void commitFile(PluginCall call) {
        String transferId = call.getString("transferId");
        if (transferId == null || transferId.isEmpty()) {
            call.reject("Download transfer id is missing", "UNKNOWN_TRANSFER");
            return;
        }

        synchronized (transferLock) {
            if (activeDownload == null || !activeDownload.transferId.equals(transferId)) {
                call.reject("Unknown download transfer", "UNKNOWN_TRANSFER");
                return;
            }
            if (activeDownload.receivedBytes != activeDownload.expectedBytes) {
                discardActiveDownloadLocked();
                call.reject("Download size does not match its declaration", "TRANSFER_SIZE_MISMATCH");
                return;
            }

            try {
                activeDownload.stream.flush();
                activeDownload.stream.close();
                activeDownload.stream = null;

                ContentValues complete = new ContentValues();
                complete.put(MediaStore.MediaColumns.IS_PENDING, 0);
                if (activeDownload.resolver.update(activeDownload.uri, complete, null, null) != 1) {
                    throw new IllegalStateException("MediaStore could not publish the download");
                }

                JSObject result = new JSObject();
                result.put(
                    "name",
                    displayNameFor(activeDownload.resolver, activeDownload.uri, activeDownload.displayName)
                );
                result.put("uri", activeDownload.uri.toString());
                activeDownload = null;
                call.resolve(result);
            } catch (Exception error) {
                discardActiveDownloadLocked();
                call.reject("Unable to commit download", "DOWNLOAD_SAVE_FAILED", error);
            } catch (OutOfMemoryError error) {
                discardActiveDownloadLocked();
                call.reject("Unable to commit download", "DOWNLOAD_SAVE_FAILED");
            }
        }
    }

    @PluginMethod
    public void abortFile(PluginCall call) {
        String transferId = call.getString("transferId");
        if (transferId == null || transferId.isEmpty()) {
            call.reject("Download transfer id is missing", "UNKNOWN_TRANSFER");
            return;
        }

        synchronized (transferLock) {
            if (activeDownload == null) {
                call.resolve();
                return;
            }
            if (!activeDownload.transferId.equals(transferId)) {
                call.reject("Unknown download transfer", "UNKNOWN_TRANSFER");
                return;
            }
            discardActiveDownloadLocked();
            call.resolve();
        }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (transferLock) {
            destroyed = true;
            discardActiveDownloadLocked();
        }
        super.handleOnDestroy();
    }
}
