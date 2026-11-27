import java.awt.BorderLayout;
import javax.accessibility.AccessibleContext;
import javax.swing.JButton;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.SwingUtilities;

public class SwingJavaFxPoc {
    public static void main(String[] args) throws Exception {
        boolean headless = Boolean.getBoolean("java.awt.headless") || java.awt.GraphicsEnvironment.isHeadless();
        if (headless) {
            JButton btn = new JButton("Phase 0 Probe");
            AccessibleContext ctx = btn.getAccessibleContext();
            System.out.println("{\"ok\":true,\"mode\":\"headless\",\"role\":\"" + ctx.getAccessibleRole() + "\",\"name\":\"" + ctx.getAccessibleName() + "\"}");
            return;
        }

        SwingUtilities.invokeAndWait(() -> {
            JFrame frame = new JFrame("DP Crawler Java Swing PoC");
            frame.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
            JButton button = new JButton("Safe Swing Action");
            JLabel status = new JLabel("idle");
            button.addActionListener(e -> {
                status.setText("clicked");
                System.out.println("SWING_BUTTON_CLICKED");
                System.out.flush();
            });
            frame.setLayout(new BorderLayout());
            frame.add(button, BorderLayout.CENTER);
            frame.add(status, BorderLayout.SOUTH);
            frame.setSize(320, 160);
            frame.setVisible(true);

            AccessibleContext ctx = button.getAccessibleContext();
            System.out.println("{\"ok\":true,\"mode\":\"swing-gui\",\"role\":\"" + ctx.getAccessibleRole() + "\",\"name\":\"" + ctx.getAccessibleName() + "\",\"javaVersion\":\"" + System.getProperty("java.version") + "\"}");
            System.out.flush();
            if (Boolean.getBoolean("poc.autoclose")) {
                frame.dispose();
            }
        });
    }
}
