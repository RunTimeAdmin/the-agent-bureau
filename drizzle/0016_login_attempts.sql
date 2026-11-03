CREATE TABLE `login_attempts` (
	`key` varchar(64) NOT NULL,
	`windowStartedAt` bigint NOT NULL,
	`count` int NOT NULL,
	CONSTRAINT `login_attempts_key` PRIMARY KEY(`key`)
);
