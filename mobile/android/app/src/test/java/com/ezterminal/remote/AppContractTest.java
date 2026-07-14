package com.ezterminal.remote;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** Host-side contract for the APK identity used by CI and in-place updates. */
public class AppContractTest {

    @Test
    public void buildIdentityMatchesReleaseContract() {
        assertEquals("com.ezterminal.remote", BuildConfig.APPLICATION_ID);
        assertEquals("0.10.0", BuildConfig.VERSION_NAME);
        assertEquals(20, BuildConfig.VERSION_CODE);
    }
}
