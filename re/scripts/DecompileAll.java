// Ghidra headless post-script: decompile every function to out/<addr>.c and one big all.c
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import java.io.*;

public class DecompileAll extends GhidraScript {
  @Override public void run() throws Exception {
    String outDir = getScriptArgs().length > 0 ? getScriptArgs()[0] : "out";
    new File(outDir).mkdirs();
    DecompInterface d = new DecompInterface();
    d.openProgram(currentProgram);
    PrintWriter all = new PrintWriter(new FileWriter(outDir + "/all.c"));
    int n = 0;
    for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
      DecompileResults r = d.decompileFunction(f, 60, monitor);
      String c = r.decompileCompleted() ? r.getDecompiledFunction().getC() : "// failed " + f.getName() + "\n";
      all.println("// ==== " + f.getEntryPoint() + " " + f.getName() + " size=" + f.getBody().getNumAddresses());
      all.println(c);
      n++;
    }
    all.close();
    println("decompiled " + n);
  }
}
