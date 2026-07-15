package com.ezterminal.remote;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(EZTerminalDownloadsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
