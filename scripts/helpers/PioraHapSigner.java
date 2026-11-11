import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class PioraHapSigner {
    private PioraHapSigner() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 8) {
            throw new IllegalArgumentException("Piora HAP signer received invalid arguments");
        }
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        char[] keyPassword = null;
        char[] storePassword = null;
        String[] signArguments = null;
        try {
            keyPassword = readSecret(reader);
            storePassword = readSecret(reader);
            signArguments = new String[] {
                "sign-app", "-mode", "localSign",
                "-keyAlias", args[0],
                "-keyPwd", new String(keyPassword),
                "-appCertFile", args[1],
                "-profileFile", args[2],
                "-profileSigned", "1",
                "-inFile", args[3],
                "-signAlg", args[4],
                "-keystoreFile", args[5],
                "-keystorePwd", new String(storePassword),
                "-pwdInputMode", "0",
                "-outFile", args[6],
                "-compatibleVersion", args[7],
                "-signCode", "1"
            };
            com.ohos.hapsigntool.HapSignTool.main(signArguments);
        } finally {
            if (keyPassword != null) Arrays.fill(keyPassword, '\0');
            if (storePassword != null) Arrays.fill(storePassword, '\0');
            if (signArguments != null) Arrays.fill(signArguments, "");
        }
    }

    private static char[] readSecret(BufferedReader reader) throws Exception {
        String value = reader.readLine();
        if (value == null || value.isEmpty() || value.length() > 256) {
            throw new IllegalArgumentException("Piora HAP signer received an invalid credential");
        }
        return value.toCharArray();
    }
}
