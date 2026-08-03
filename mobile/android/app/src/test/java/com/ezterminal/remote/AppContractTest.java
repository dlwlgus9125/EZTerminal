package com.ezterminal.remote;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Host-side contract for the APK identity used by CI and in-place updates. */
public class AppContractTest {

    @Test
    public void buildIdentityMatchesReleaseContract() {
        assertEquals("com.ezterminal.remote", BuildConfig.APPLICATION_ID);
        assertTrue(BuildConfig.VERSION_NAME.matches("\\d+\\.\\d+\\.\\d+"));
        assertTrue(BuildConfig.VERSION_CODE > 0);
    }

    @Test
    public void downloadNamesCannotEscapeTheMediaStoreCollection() {
        assertEquals("report.txt", EZTerminalDownloadsPlugin.safeDisplayName("report.txt"));
        assertEquals("한글 보고서.txt", EZTerminalDownloadsPlugin.safeDisplayName("한글 보고서.txt"));
        assertNull(EZTerminalDownloadsPlugin.safeDisplayName("../report.txt"));
        assertNull(EZTerminalDownloadsPlugin.safeDisplayName("folder/report.txt"));
        assertNull(EZTerminalDownloadsPlugin.safeDisplayName("folder\\report.txt"));
        assertNull(EZTerminalDownloadsPlugin.safeDisplayName("report\nforged.txt"));
        assertNull(EZTerminalDownloadsPlugin.safeDisplayName(".."));
        assertNull(EZTerminalDownloadsPlugin.safeDisplayName(
            "한한한한한한한한한한한한한한한한한한한한한한한한한한한한한한"
                + "한한한한한한한한한한한한한한한한한한한한한한한한한한한한"
                + "한한한한한한한한한한한한한한한한한한한한한한한"
        ));
    }

    @Test
    public void downloadCollisionsPreserveTheExtensionAndByteLimit() {
        assertEquals("report (1).txt", EZTerminalDownloadsPlugin.collisionDisplayName("report.txt", 1));
        assertEquals("archive.tar (2).gz", EZTerminalDownloadsPlugin.collisionDisplayName("archive.tar.gz", 2));
        String longName = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            + "aaaaaaaaaaaaaaaaaaaa.txt";
        String collision = EZTerminalDownloadsPlugin.collisionDisplayName(longName, 999);
        assertTrue(collision.endsWith(" (999).txt"));
        assertTrue(collision.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= 240);
    }

    @Test
    public void nativeDownloadBridgeMatchesTheSharedTransferLimits() {
        assertEquals(50 * 1_048_576, EZTerminalDownloadsPlugin.MAX_DOWNLOAD_BYTES);
        assertEquals(256 * 1_024, EZTerminalDownloadsPlugin.MAX_CHUNK_BYTES);
    }

    @Test
    public void updateDownloadAcceptsOnlyTheExactGitHubReleaseAsset() {
        String valid = "https://github.com/dlwlgus9125/EZTerminal/releases/download/"
            + "v1.2.3/EZTerminal-Android-1.2.3-vc44.apk";
        assertTrue(EZTerminalUpdatePlugin.isValidInitialDownloadUrl(
            valid,
            "EZTerminal-Android-1.2.3-vc44.apk",
            "1.2.3",
            44
        ));
        assertTrue(!EZTerminalUpdatePlugin.isValidInitialDownloadUrl(
            valid.replace("https://github.com", "https://example.com"),
            "EZTerminal-Android-1.2.3-vc44.apk",
            "1.2.3",
            44
        ));
        assertTrue(!EZTerminalUpdatePlugin.isValidInitialDownloadUrl(
            valid,
            "other.apk",
            "1.2.3",
            44
        ));
    }

    @Test
    public void updateRedirectsStayOnHttpsGitHubAssetHosts() {
        assertTrue(EZTerminalUpdatePlugin.isAllowedRedirectUrl(
            "https://release-assets.githubusercontent.com/github-production-release-asset/file.apk?token=x"
        ));
        assertTrue(!EZTerminalUpdatePlugin.isAllowedRedirectUrl(
            "http://release-assets.githubusercontent.com/file.apk"
        ));
        assertTrue(!EZTerminalUpdatePlugin.isAllowedRedirectUrl(
            "https://example.com/file.apk"
        ));
        assertEquals(100 * 1_048_576, EZTerminalUpdatePlugin.MAX_UPDATE_BYTES);
        assertEquals(5, EZTerminalUpdatePlugin.MAX_REDIRECTS);
    }
}
