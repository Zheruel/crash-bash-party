// decompile functions at given addresses (hex list in env ADDRS), creating them when missing -> out file
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.address.*;
import java.io.*;
public class DecompAddrs extends GhidraScript {
  @Override public void run() throws Exception {
    String out = getScriptArgs()[0];
    String[] addrs = System.getenv("ADDRS").split(",");
    DecompInterface d = new DecompInterface();
    d.openProgram(currentProgram);
    PrintWriter w = new PrintWriter(new FileWriter(out));
    for (String s : addrs) {
      Address a = toAddr(Long.parseLong(s.trim(), 16));
      Function f = getFunctionAt(a);
      if (f == null) {
        clearListing(a, a.add(3));
        disassemble(a);
        f = createFunction(a, null);
      }
      if (f == null) { w.println("// ==== " + a + " CREATE FAILED"); continue; }
      DecompileResults r = d.decompileFunction(f, 120, monitor);
      w.println("// ==== " + f.getEntryPoint() + " " + f.getName() + " size=" + f.getBody().getNumAddresses());
      w.println(r.decompileCompleted() ? r.getDecompiledFunction().getC() : "// failed");
    }
    w.close();
  }
}
