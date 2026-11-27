using System.Windows.Forms;

namespace WinFormsFixture;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        var form = new Form { Text = "DP Crawler WinForms Fixture", Width = 460, Height = 320 };

        var statusLabel = new Label { Name = "statusLabel", Text = "idle", Left = 20, Top = 180, Width = 380 };
        var safeBtn = new Button { Name = "safeBtn", Text = "Inspect Info", Left = 20, Top = 50, Width = 140 };
        safeBtn.Click += (_, _) => statusLabel.Text = "safe-clicked";

        var deleteBtn = new Button { Name = "deleteBtn", Text = "Delete Record", Left = 180, Top = 50, Width = 140 };
        deleteBtn.Click += (_, _) => statusLabel.Text = "MUTATION_EXECUTED";

        var disabledBtn = new Button { Name = "disabledBtn", Text = "Disabled Action", Left = 20, Top = 95, Width = 140, Enabled = false };
        var toggleCheck = new CheckBox { Name = "toggleCheck", Text = "Enable Preview", Left = 180, Top = 95, Width = 160 };
        var dialogBtn = new Button { Name = "dialogBtn", Text = "Open Dialog", Left = 20, Top = 135, Width = 140 };
        dialogBtn.Click += (_, _) => MessageBox.Show(form, "Safe modal dialog", "Fixture Dialog", MessageBoxButtons.OK);

        var menuStrip = new MenuStrip();
        var fileMenu = new ToolStripMenuItem("File");
        fileMenu.DropDownItems.Add("Inspect Status", null, (_, _) => statusLabel.Text = "menu-clicked");
        menuStrip.Items.Add(fileMenu);

        form.MainMenuStrip = menuStrip;
        form.Controls.AddRange(new Control[] { menuStrip, safeBtn, deleteBtn, disabledBtn, toggleCheck, dialogBtn, statusLabel });
        Application.Run(form);
    }
}
