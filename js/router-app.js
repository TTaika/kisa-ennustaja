// App bootstrap: registers every view under the hamburger-menu nav.
import { register, start } from "./router.js";
import { initDemoChrome } from "./util/demo.js";
import { initNavMenu } from "./util/navmenu.js";
import { initPrintExpand } from "./util/printExpand.js";
import * as tehtavat from "./views/tehtavat.js";
import * as rastit from "./views/rastit.js";
import * as radat from "./views/radat.js";
import * as kartta from "./views/kartta.js";
import * as sarjat from "./views/sarjat.js";
import * as ennuste from "./views/ennuste.js";
import * as asetukset from "./views/asetukset.js";

register("tehtava", tehtavat.render);
register("rasti", rastit.render);
register("rata", radat.render);
register("kartta", kartta.render);
register("sarja", sarjat.render);
register("ennuste", ennuste.render);
register("asetukset", asetukset.render);

initDemoChrome();
initNavMenu();
initPrintExpand();
start();
