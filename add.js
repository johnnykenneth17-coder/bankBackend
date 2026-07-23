const serviceRegistryAdminRouter = require("../lib/service-registry-admin-routes");
app.use("/api/sys/service-registry", authenticate, authorizeAdmin, serviceRegistryAdminRouter);