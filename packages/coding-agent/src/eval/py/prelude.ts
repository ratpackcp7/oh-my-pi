import pythonPrelude from "./prelude.py" with { type: "text" };
import pythonRecoveryPrelude from "./recovery.py" with { type: "text" };

export const PYTHON_PRELUDE = `${pythonPrelude}\n${pythonRecoveryPrelude}`;
