// pre-analysis: seed functions at every data word that points at a function prologue (addiu sp,sp,-N)
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
public class Setup extends GhidraScript {
  @Override public void run() throws Exception {
    long lo = 0x80010000L, hi = 0x800d7148L; String ov = System.getenv("OVL_END"); if (ov != null) hi = Long.parseLong(ov, 16);
    java.util.TreeSet<Long> seeds = new java.util.TreeSet<>();
    seeds.add(0x8002e7b0L);
    for (long a = lo; a + 4 <= hi; a += 4) {
      long v = getInt(toAddr(a)) & 0xffffffffL;
      if (v < lo || v >= hi || (v & 3) != 0) continue;
      long ins = getInt(toAddr(v)) & 0xffffffffL;
      if ((ins & 0xffff0000L) == 0x27bd0000L && (ins & 0x8000L) != 0) seeds.add(v); // addiu sp,sp,-N
    }
    // also: jal targets
    for (long a = lo; a + 4 <= hi; a += 4) {
      long ins = getInt(toAddr(a)) & 0xffffffffL;
      if ((ins >>> 26) == 3) { long t = 0x80000000L | ((ins & 0x3ffffffL) << 2); if (t >= lo && t < hi) { long i2 = getInt(toAddr(t)) & 0xffffffffL; if ((i2 & 0xffff0000L) == 0x27bd0000L) seeds.add(t); } }
    }
    for (long s : seeds) { Address x = toAddr(s); disassemble(x); if (getFunctionAt(x) == null) createFunction(x, null); }
    println("seeded " + seeds.size());
  }
}
