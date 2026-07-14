package com.ezterminal.remote;

import static org.junit.Assert.assertEquals;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Device-side contract for the installed APK identity. */
@RunWith(AndroidJUnit4.class)
public class AppInstrumentedTest {

    @Test
    public void installedAppMatchesReleaseContract() throws Exception {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("com.ezterminal.remote", appContext.getPackageName());

        PackageInfo packageInfo = appContext.getPackageManager().getPackageInfo(appContext.getPackageName(), 0);
        long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? packageInfo.getLongVersionCode()
            : packageInfo.versionCode;
        assertEquals("0.10.0", packageInfo.versionName);
        assertEquals(20L, versionCode);
    }
}
