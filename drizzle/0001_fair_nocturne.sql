CREATE TABLE `inquiries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(120) NOT NULL,
	`email` varchar(320) NOT NULL,
	`interest` enum('Hire an agent','Become a provider','Partnership','General inquiry') NOT NULL,
	`message` text NOT NULL,
	`reference` varchar(48) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`status` enum('new','reviewed','closed') NOT NULL DEFAULT 'new',
	CONSTRAINT `inquiries_id` PRIMARY KEY(`id`),
	CONSTRAINT `inquiries_reference_unique` UNIQUE(`reference`)
);
